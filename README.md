# 屏幕墙（screen-wall）

Windows 屏幕墙应用：在一个画布上自由编排**视频 / 图片 / 网站**三种组件，开机后全屏播放，托盘常驻。适用于广告机、展厅大屏、信息展示等场景。

## 功能特性

- **三种组件**：视频（循环自动播放，音量开关）、图片、网页（页面缩放 25%–400%）
- **画布编排**：自定义画布分辨率（默认当前屏幕分辨率），组件拖放添加、拖动、缩放、旋转（0/90/180/270 自动吸附）、水平/垂直镜像
- **全屏播放**：启动即全屏播放最近保存的项目，黑底自适应缩放居中
- **托盘常驻**：右键托盘图标打开编辑器 / 显示播放器 / 退出
- **项目管理**：多项目，保存后立即生效（播放器热更新），下次启动自动加载最近保存的项目

## 下载安装

从 [Releases](../../releases) 下载 `ScreenWall-Setup-x.y.z.exe`，双击一键安装（无需管理员权限）：

- 安装完成后**默认注册开机自启**（可在任务管理器 → 启动应用 中关闭）
- 不会立刻抢占屏幕，登录后自动运行；也可从开始菜单手动启动
- 卸载时自动清理开机自启项

## 开发运行

```bash
npm install
npm start          # 全屏播放器
npm run editor     # 打开编辑器
```

自检命令：

```bash
npm run smoke      # 启动冒烟
npm run verify     # 渲染层功能断言（保存/回读/缩放/比例）
```

## 打包

```bash
npm run dist       # 生成 dist/ScreenWall-Setup-x.y.z.exe
```

## 发布流程

推送 `v*` 格式的 tag，GitHub Actions 会自动运行自检、构建安装包并发布到 Releases：

```bash
git tag v0.1.1
git push origin v0.1.1
```

## 配置与数据

- 应用配置与项目文件位于 `%APPDATA%\screen-wall`
- 项目保存在 `projects\<id>.json`（画布分辨率 + 组件列表），`settings.json` 记录当前项目
- 组件的媒体源使用本机绝对路径或网址；换机器部署时注意媒体文件路径

## 已知限制

- **网页组件**使用 iframe 内嵌，少数禁止内嵌的站点会显示空白
- **视频解码**走 Chromium 内置能力（H.264/VP9/AV1 等），MKV/HEVC 等格式支持有限

## 目录结构

```
src/
  main.js          主进程：托盘、播放器/编辑器窗口、IPC
  config.js        项目与配置存储
  preload.js       渲染进程 API 桥
  player/          全屏播放器
  editor/          可视化编辑器
build/
  icon.ico         应用图标
  installer.nsh    安装器：注册/清理开机自启
.github/workflows/
  release.yml      tag 触发的构建发布工作流
```
