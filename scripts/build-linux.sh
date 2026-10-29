#!/usr/bin/env bash
# 构建 Nomo 的 Linux 安装包（RPM 和/或 DEB），并可选安装。
#
# 用法:
#   bash scripts/build-linux.sh                  # 构建 rpm + deb
#   bash scripts/build-linux.sh --bundles rpm    # 仅构建 rpm
#   bash scripts/build-linux.sh --bundles deb    # 仅构建 deb
#   bash scripts/build-linux.sh --install        # 构建全部并安装到系统
#   bash scripts/build-linux.sh -i --bundles deb # 仅构建 deb 并安装
#
# 环境要求: Linux，已安装 gtk3、webkit2gtk-4.1、Node、pnpm、Rust、GNU coreutils。
#           安装 rpm 需要 rpm 包管理器；安装 deb 需要 dpkg，优先由 apt-get 处理依赖。
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Nomo Linux packages can only be built on Linux." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle"
TAURI_CONF="$ROOT_DIR/src-tauri/tauri.conf.json"
PNPM_BIN="${PNPM_BIN:-pnpm}"

# 默认同时构建 rpm 与 deb；可通过 --bundles 覆盖。
BUNDLES="rpm,deb"
INSTALL=false

print_help() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --install|-i) INSTALL=true ;;
    --bundles) shift_next=true ;;
    --bundles=*) BUNDLES="${arg#--bundles=}" ;;
    --help|-h) print_help; exit 0 ;;
    *)
      if [[ "${shift_next:-}" == "true" ]]; then
        BUNDLES="$arg"
        shift_next=false
      else
        echo "Unknown argument: $arg" >&2
        echo "Run with --help for usage." >&2
        exit 2
      fi
      ;;
  esac
done

# 校验 bundles 取值，拆分为数组。
IFS=',' read -ra BUNDLE_LIST <<< "$BUNDLES"
for b in "${BUNDLE_LIST[@]}"; do
  case "$b" in
    rpm|deb) ;;
    *)
      echo "Invalid bundle type '$b'. Supported: rpm, deb" >&2
      exit 2
      ;;
  esac
done

cd "$ROOT_DIR"

# 从 tauri.conf.json 读取 productName，用于推导各格式文件名与包名。
# Tauri 归一化规则（实测）：
#   - RPM 文件名: <ProductName>-<version>-<release>.<arch>.rpm（保留大小写）
#   - DEB 文件名: <ProductName>_<version>_<arch>.deb（保留大小写、下划线分隔）
#   - 包名（rpm -q / dpkg-query 查询用）: productName 转小写并去除空白
PRODUCT_NAME="$(grep -o '"productName"[[:space:]]*:[[:space:]]*"[^"]*"' "$TAURI_CONF" \
  | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/')"
if [[ -z "$PRODUCT_NAME" ]]; then
  echo "Failed to read productName from $TAURI_CONF." >&2
  exit 1
fi
PACKAGE_NAME="$(echo "$PRODUCT_NAME" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
# RPM 与 DEB 文件名均保留 productName 原样大小写（Tauri 实际行为）。
# 包名（rpm -q / dpkg-query 查询用）才转为小写。
# 架构（x86_64/aarch64 等）由构建机决定，不硬编码，用通配符匹配。
RPM_NAME_GLOB="${PRODUCT_NAME// /}-*.*.rpm"
DEB_NAME_GLOB="${PRODUCT_NAME// /}_*.deb"

# 1. 前端依赖
echo "==> Installing frontend dependencies..."
"$PNPM_BIN" install --frozen-lockfile

# 2. 构建（仅指定 bundle，避免生成其他格式）
echo "==> Building bundles: $BUNDLES ..."
"$PNPM_BIN" exec tauri build --bundles "$BUNDLES"

# 按修改时间取最新产物，避免残留旧版干扰。
# 使用 ls -t 而非 find -printf，避免依赖 GNU find 的 -printf 扩展。
# Tauri 构建会生成与产物同名的解包目录（如 Nomo-*.x86_64/、Nomo_*.aarch64/），
# 需用 [[ -f ]] 过滤，只保留普通文件。
latest_artifact() {
  local dir="$1" glob="$2"
  [[ -d "$dir" ]] || return 0
  shopt -s nullglob
  local matches=("$dir"/$glob)
  shopt -u nullglob
  # 无匹配时 ls 会收到空参数并列出当前目录，故先判空。
  [[ ${#matches[@]} -eq 0 ]] && return 0
  mapfile -t candidates < <(ls -t "${matches[@]}" 2>/dev/null)
  for c in "${candidates[@]}"; do
    if [[ -f "$c" ]]; then
      echo "$c"
      return
    fi
  done
}

print_artifact() {
  local path="$1" label="$2"
  echo "==> Built [$label]: $path"
  echo "    Size:  $(du -h "$path" | awk '{print $1}')"
  echo "    MD5:   $(md5sum "$path" | awk '{print $1}')"
}

# 收集各格式的产物路径，供后续安装使用。
declare -A ARTIFACTS=()
for b in "${BUNDLE_LIST[@]}"; do
  case "$b" in
    rpm)
      path="$(latest_artifact "$BUNDLE_DIR/rpm" "$RPM_NAME_GLOB")"
      if [[ -z "$path" ]]; then
        echo "No RPM artifact matching '$RPM_NAME_GLOB' found under $BUNDLE_DIR/rpm." >&2
        exit 1
      fi
      ARTIFACTS[rpm]="$path"
      print_artifact "$path" "rpm"
      ;;
    deb)
      path="$(latest_artifact "$BUNDLE_DIR/deb" "$DEB_NAME_GLOB")"
      if [[ -z "$path" ]]; then
        echo "No DEB artifact matching '$DEB_NAME_GLOB' found under $BUNDLE_DIR/deb." >&2
        exit 1
      fi
      ARTIFACTS[deb]="$path"
      print_artifact "$path" "deb"
      ;;
  esac
done

# 3. 可选安装：只安装当前系统适用的那一种格式，避免同时安装 rpm+deb。
#    优先检测 dpkg（Debian 系），其次 rpm（Red Hat 系）。
#    若 --bundles 限定了单一格式，则只考虑该格式。
if [[ "$INSTALL" == "true" ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
  else
    SUDO=""
  fi

  # 根据可用的包管理器与已构建的产物，决定安装哪种格式。
  install_format=""
  if [[ " ${BUNDLE_LIST[*]} " == *" deb "* ]] && command -v dpkg >/dev/null 2>&1; then
    install_format="deb"
  elif [[ " ${BUNDLE_LIST[*]} " == *" rpm "* ]] && command -v rpm >/dev/null 2>&1; then
    install_format="rpm"
  fi

  if [[ -z "$install_format" ]]; then
    echo "No installable package found for this system." >&2
    echo "Built bundles: ${BUNDLE_LIST[*]}; available package managers checked: dpkg, rpm." >&2
    exit 1
  fi

  path="${ARTIFACTS[$install_format]}"
  name="$(basename "$path")"
  echo "==> Installing $name ($install_format)..."
  case "$install_format" in
    rpm)
      # 升级或全新安装均可，-U 对已安装旧版会自动升级。
      $SUDO rpm -Uvh --force "$path"
      installed="$(rpm -q "$PACKAGE_NAME" --queryformat '%{VERSION}-%{RELEASE}.%{ARCH}' 2>/dev/null || true)"
      ;;
    deb)
      # 让 APT 在安装本地包时解析依赖，避免 dpkg 缺依赖失败后被 set -e 提前中断。
      if command -v apt-get >/dev/null 2>&1; then
        $SUDO apt-get install -y "$path"
      else
        $SUDO dpkg -i "$path"
      fi
      installed="$(dpkg-query -W -f='${Version}' "$PACKAGE_NAME")"
      ;;
  esac
  echo "    Installed: $PACKAGE_NAME-$installed"
  echo "==> Done. Run with: $PACKAGE_NAME"
fi
