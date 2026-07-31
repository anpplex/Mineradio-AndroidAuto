# Mineradio 华为 Android 12 车机适配包

此目录把用户提供的 Android APK 重新打包为**横屏车机启动包**；它不是把上游 Electron 桌面工程直接编译成 Android。

## 已做的车机适配

- 启动入口由 `MainActivity` 切换为 APK 内已有的 `LandscapeWebActivity`。
  - 该 Activity 自身会请求横屏、沉浸全屏并保持屏幕常亮，适合固定横向中控屏。
- 启动 Intent 同时包含普通 `LAUNCHER` 与 `CAR_LAUNCHER`，便于常规 Android Launcher 和支持车载类别查询的 Launcher 发现应用。
- `LandscapeWebActivity` 显式设为 `exported=true`，满足 Android 12 对带 Intent filter 组件的要求。
- 所有声明为 portrait 的 Activity manifest 方向改为 landscape；应用声明为 `resizeableActivity=true`，更适合非手机比例的中控/副屏。
- 保留原 APK 的包名、媒体播放服务、存储权限、`arm64-v8a` 原生库和应用资源；不触碰应用逻辑、音频服务或网络接口。
- 解包后的 `assets/mineradio/index.html` 与新建 `car-hmi.css` 会按原 APK 的 `MENC + IV + AES-256-CBC` 资源格式重新加密；不依赖明文资源落入最终 APK。

## 车机 HMI overlay

车机 HMI overlay 面向已实测的 Huawei `ICHU3200E15-ADV`、Android 12、**1920×1080 横屏 @ 320dpi**环境。它是本项目的可读性与触控目标，**不是华为 OEM 官方认证或强制尺寸规范**。

- **CSS 视口**：APK 内 `index.html` 使用 `width=device-width`。在 320dpi（density 2.0）上，WebView CSS 视口约为 **960×540 px**，不是物理 1920×1080。HMI media query 必须按 **CSS 像素** 匹配，不能按物理像素写 `1548px` 一类门槛（那会永远不生效）。
- 生效下限：CSS 横向宽度 `900px`、高度 `480px`（覆盖本机约 960×540 的 WebView）。
- 布局：内容与底栏最大宽度约 `920px`（CSS），双栏约 `280 + 420` 起步，间距 `12 / 16 / 20 / 24px`。
- 触控：常规操作最小 `48×48` CSS px（约 96 物理 px @ 320dpi）；播放/暂停主操作 `64×64` CSS px（约 128 物理 px）。
- 字体（CSS px）：搜索与主播放信息 `18px`，首页卡片标题 `20px`，最近播放标题 `22px`，艺人/次级 `14px`。
- 驾驶态优先：首页大卡片、搜索、最近播放、上一首/播放/下一首/队列优先；粒子背景降低并关闭首页卡片漂浮动画；桌面低频播放控件（音质/红心/收藏/音效/音量等）在车机底栏中隐藏。
- 登录：新增固定的“网易云扫码登录”入口，仅调用原页面已有的 `showLoginModal()`；不会绕过认证、伪造登录或处理账号凭据。
- 焦点：触摸外的键盘/旋钮焦点使用高对比描边；真实车机的方向键、旋钮焦点路径仍需实机验收。

当前静态验证已覆盖 MENC 加解密回环、HTML/CSS 注入幂等、登录入口和关键 HMI token。2026-07-31 已在实车确认旧 media query 未生效；**密度感知修复后需重新构建并安装再验收**。

## 当前产物

- 输入：`/Users/anpple/Downloads/Mineradio_1.1.7.0.apk`
- 输入 SHA-256：`72c13fe4d1735569e80fe20ef73920d199a21e854dac281d938b532e9cb2c637`
- 输出：`android-car/out/Mineradio-1.1.7.0-huawei-android12-car.apk`
- 输出 SHA-256：以同目录 `.sha256` 文件为准。

## 已验证的静态契约

构建脚本会验证：

1. APK ZIP 完整性（`unzip -tqq`）；
2. APK v2/v3 签名有效性（`apksigner verify --verbose`）；
3. 唯一启动入口是 `com.mineradio.app.LandscapeWebActivity`；
4. manifest 含 `android.intent.category.CAR_LAUNCHER`；
5. application 含 `android:resizeableActivity="true"`；
6. HMI HTML/CSS overlay 的 MENC 加密资源可被解密回读，且登录入口注入幂等；
7. 新 APK 必须以与车机现有 `com.mineradio.app` 相同的证书签名，才允许覆盖安装。

已完成的是既有横屏适配包的实车安装与启动基线验证；当前 HMI overlay 尚未在车机屏幕上完成触控、焦点、音频焦点、休眠恢复或 U 盘扫描验收。

## 华为 Android 12 实车安装

该车机的普通 `adb install` 会被 HMI 的安装确认页拒绝（`INSTALL_FAILED_ABORTED: User rejected permissions`）。请使用仓库内按 Lyra 验证过的安装逻辑：APK 先 push 到 shell 临时目录，暂时停用 `PackageInstaller`，以 `com.huawei.appinstaller.car` 身份对车机用户 12 调用 `pm install`，再恢复 `PackageInstaller` 原先的启用/停用状态。

> 这个流程只用于用户已授权的开发车机；不会修改系统分区、绕过 Android 签名校验，且不向 `upstream` 推送任何内容。

1. 确认设备型号、Android 版本与 ABI：

   ```sh
   adb -s LD249H019625 shell getprop ro.build.version.release
   adb -s LD249H019625 shell getprop ro.product.cpu.abilist
   ```

   已实测目标为 Huawei `ICHU3200E15-ADV`、Android 12（API 31）、`arm64-v8a`、1920×1080，车机应用用户为 `12`。适配 APK 的 ABI 与该设备匹配。

2. 安装并以真正的全屏窗口启动：

   ```sh
   ./android-car/scripts/install-huawei-car.sh LD249H019625 \
     ./android-car/out/Mineradio-1.1.7.0-huawei-android12-car.apk
   ```

   脚本默认用户是 `12`，可在**确认目标用户正确**时覆盖：

   ```sh
   TARGET_USER=12 ./android-car/scripts/install-huawei-car.sh <serial> <apk-path>
   ```

   关键安装命令等同于：

   ```sh
   pm install -r -d -g -t -i com.huawei.appinstaller.car --user 12 \
     /data/local/tmp/Mineradio-1.1.7.0-huawei-android12-car.apk
   ```

   它会在退出时删除临时 APK，并在成功或失败时恢复 `com.android.packageinstaller` 在 user 12 和 user 0 的**原始状态**。

   如果旧包的签名密钥已永久不可用，只能做**会清除 user 12 应用数据、登录态和设置**的干净重装；必须显式确认，默认安装流程绝不会卸载旧包：

   ```sh
   CLEAN_REINSTALL=1 ALLOW_DATA_LOSS_REINSTALL=YES TARGET_USER=12 \
     ./android-car/scripts/install-huawei-car.sh LD249H019625 <newly-signed-apk>
   ```

3. 如只需重新验证全屏启动，不需再安装：

   ```sh
   adb -s LD249H019625 shell am force-stop --user 12 com.mineradio.app
   adb -s LD249H019625 shell am start --user 12 --windowingMode 1 -W \
     -n com.mineradio.app/.LandscapeWebActivity
   ```

   直接启动时华为 HMI 可能将应用放到 `hwMultiwindow-secondary` 的右侧区域；先停止应用并指定 `--windowingMode 1` 已在该实车验证为 1920×1080 全屏窗口。

### 已完成的实车验证（2026-07-30）

- Lyra 安装逻辑安装到 user 12 成功；`pm path`、版本 `1.1.7.0`/`4107000` 和 installer `com.huawei.appinstaller.car` 均已核验。
- `LandscapeWebActivity` 已启动为 resumed 的全屏窗口；通过 ADB 点击启动页后进入 Mineradio 主界面。
- 运行日志未发现 `FATAL EXCEPTION` 或 `ANR in com.mineradio.app`。

### 尚未通过的验收项

不要将以下项目表述为已兼容：OEM Launcher 的图标发现/默认窗口策略、本地音乐或 U 盘扫描、音频焦点/蓝牙媒体通道、熄屏/ACC/休眠恢复、后台播放。

实车日志已显示 Android 12 MediaProvider **拒绝**应用创建共享存储顶级目录 `SPICaMusic`：

```text
MediaProvider: Creating a non-default top level directory ... is not allowed! ... SPICaMusic
LandscapeWebActivity: FileNotFoundException: /storage/emulated/12/SPICaMusic/mineradio_settings.json
```

这是上游 APK 硬编码路径与 Android 12 scoped storage 的冲突；当前适配包**不修改**原生业务 smali，因此设置文件无法落到该共享路径。安装、横屏启动与 HMI 不受此项阻塞，但依赖 `SPICaMusic/` 的本地设置持久化/本地库扫描不能宣称已兼容。后续若做存储兼容，应改为 app-specific 目录或 `Music/SPICaMusic` 等合法路径，而不是 ADB 强行建目录。本地音乐扫描仍需插入含音乐文件的 U 盘后单独验收。

## 复现构建

依赖：JDK 17+、Android build-tools（含 `aapt` 与 `apksigner`）、APKTool 3.0.2（已做静态资源验证）。签名密钥必须是现有车机包使用的密钥；构建脚本**不会**自动生成新证书。

```sh
export JAVA_HOME=/path/to/jdk
export APKTOOL_JAR=/absolute/path/to/apktool_3.0.2.jar
export ANDROID_BUILD_TOOLS="$HOME/Library/Android/sdk/build-tools/35.0.0"
# 仅在本机安全注入已有车机适配包的 keystore 密码；不要把密码写入脚本、Git 或终端历史。
export MINERADIO_CAR_KEYSTORE_PASSWORD='...'
./android-car/scripts/build-car-apk.sh /absolute/path/to/Mineradio_1.1.7.0.apk
```

构建前需核对 `android-car/.signing/mineradio-car.jks` 的 `mineradio-car` 别名证书 SHA-256 是否为：

```text
6A:57:CF:A1:88:D8:70:4D:B6:E7:C8:4A:87:3F:57:B1:1E:DF:B3:34:53:A2:36:BA:3A:9C:32:7B:69:C5:7B:D9
```

如果证书不匹配、keystore 缺失或密码不可用，停止构建/安装；不得卸载现有包来规避签名不匹配，因为这可能清除应用数据、登录态和设置。`android-car/.signing/`、`android-car/out/`、`android-car/verification/` 均被 Git 忽略，不能提交 APK、JKS、密码、截图、Cookie 或令牌。
