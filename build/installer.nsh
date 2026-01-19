!macro customInstall
  ; Auto-start for all users (HKLM)
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ZenterBridge" "$INSTDIR\${PRODUCT_FILENAME}.exe"
!macroend

!macro customUnInstall
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "ZenterBridge"
!macroend
