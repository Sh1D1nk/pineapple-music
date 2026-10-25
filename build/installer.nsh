; 自定义 NSIS 逻辑（electron-builder nsis.include 引入）
; 默认安装目录设到 D 盘：D 盘存在时预填 D:\Pineapple Music，
; 向导里用户仍可自由修改（allowToChangeInstallationDirectory 已开）。
!macro customInit
  IfFileExists "D:\*" 0 no_default_d
    StrCpy $INSTDIR "D:\Pineapple Music"
  no_default_d:
!macroend
