cask "nomor" do
  version "0.6.2"
  sha256 "e38f6e08ed317566225d4426012b4806074c7d138589c92e0bd10d2f499a3190"

  url "https://github.com/whitelunatix/nomor/releases/download/v#{version}/Nomor_#{version}_aarch64.dmg"
  name "Nomor"
  desc "Local-first Markdown desktop editor"
  homepage "https://github.com/whitelunatix/nomor"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :monterey

  app "Nomor.app"

  zap trash: [
    "~/Library/Application Support/com.nomor.desktop",
    "~/Library/Caches/com.nomor.desktop",
    "~/Library/Logs/com.nomor.desktop",
    "~/Library/Preferences/com.nomor.desktop.plist",
    "~/Library/WebKit/com.nomor.desktop",
  ]
end
