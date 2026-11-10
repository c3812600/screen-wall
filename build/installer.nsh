; 安装器自定义逻辑：安装后默认注册开机自启（当前用户 Run 键）
; 由 electron-builder 的 nsis.include 引入

!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ScreenWall" "$INSTDIR\ScreenWall.exe"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ScreenWall"
!macroend
