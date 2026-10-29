!macro NSIS_HOOK_POSTINSTALL
  ; 注册到 Windows“打开方式”候选列表，但不改写任何文档类型的默认程序。
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".markdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".txt" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".json" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\Nomor.Markdown" "" "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\Nomor.Markdown\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Nomor.Markdown\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Nomor.Markdown\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\Nomor.Text" "" "Text Document"
  WriteRegStr SHCTX "Software\Classes\Nomor.Text\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Nomor.Text\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Nomor.Text\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\Nomor.Json" "" "JSON Document"
  WriteRegStr SHCTX "Software\Classes\Nomor.Json\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Nomor.Json\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Nomor.Json\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\.md\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "Nomor.Markdown" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "Nomor.Markdown" ""
  WriteRegStr SHCTX "Software\Classes\.txt\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.txt\OpenWithProgids" "Nomor.Text" ""
  WriteRegStr SHCTX "Software\Classes\.json\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.json\OpenWithProgids" "Nomor.Json" ""

  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载时只移除 Nomor 自己注册的打开方式入口，保留用户选择的其他默认程序。
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\Classes\Nomor.Markdown"
  DeleteRegKey SHCTX "Software\Classes\Nomor.Text"
  DeleteRegKey SHCTX "Software\Classes\Nomor.Json"
  DeleteRegKey SHCTX "Software\Classes\.md\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "Nomor.Markdown"
  DeleteRegKey SHCTX "Software\Classes\.markdown\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "Nomor.Markdown"
  DeleteRegKey SHCTX "Software\Classes\.txt\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\Classes\.txt\OpenWithProgids" "Nomor.Text"
  DeleteRegKey SHCTX "Software\Classes\.json\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\Classes\.json\OpenWithProgids" "Nomor.Json"

  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend
