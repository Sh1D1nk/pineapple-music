把 ffmpeg.exe 放到这个目录，安装包会把它作为 resources/bin/ffmpeg.exe 一起分发。

优先使用 ffmpeg-static（可选依赖，安装时会从 GitHub 下载）；如果那一步失败，
应用会依次查找：
  1. 环境变量 LOCALMUSIC_FFMPEG
  2. node_modules/ffmpeg-static/ffmpeg.exe
  3. <安装目录>/resources/bin/ffmpeg.exe
  4. 系统 PATH 中的 ffmpeg

注意：ffmpeg 的许可证取决于具体构建（Gyan 的 full build 为 GPLv3）。商用分发前请自行确认。
