# Mineradio 华为 Android 12 车机适配包

此目录把用户提供的 Android APK 重新打包为**横屏车机启动包**；它不是把上游 Electron 桌面工程直接编译成 Android。

## 已做的车机适配

- 启动入口由 `MainActivity` 切换为 APK 内已有的 `LandscapeWebActivity`。
  - 该 Activity 自身会请求横屏、沉浸全屏并保持屏幕常亮，适合固定横向中控屏。
- 启动 Intent 同时包含普通 `LAUNCHER` 与 `CAR_LAUNCHER`，便于常规 Android Launcher 和支持车载类别查询的 Launcher 发现应用。
- `LandscapeWebActivity` 显式设为 `exported=true`，满足 Android 12 对带 Intent filter 组件的要求。
- 所有声明为 portrait 的 Activity manifest 方向改为 landscape；应用声明为 `resizeableActivity=true`，更适合非手机比例的中控/副屏。
- 保留原 APK 的包名、媒体播放服务、存储权限、`arm64-v8a` 原生库和应用资源；不触碰应用逻辑、音频服务或网络接口。

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
5. application 含 `android:resizeableActivity="true"`。

当前没有连接到真实华为车机，因此**尚未完成实车安装、触控、音频焦点、休眠恢复或 U 盘扫描验证**。

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

实车日志已显示 Android 12 拒绝创建共享存储顶级目录 `SPICaMusic`；安装和主界面不受此项影响，但本地音乐扫描仍需插入含音乐文件的 U 盘后单独验收。

## 复现构建

依赖：JDK 17+、Android build-tools（含 `aapt` 与 `apksigner`）、APKTool `2.11.1`。

```sh
export JAVA_HOME=/path/to/jdk
export APKTOOL_JAR=/absolute/path/to/apktool_2.11.1.jar
export MINERADIO_CAR_KEYSTORE_PASSWORD='choose-a-local-secret'
./android-car/scripts/build-car-apk.sh /absolute/path/to/Mineradio_1.1.7.0.apk
```

构建签名密钥保存在 `android-car/.signing/`，已被 Git 忽略。请安全备份该密钥；丢失它后，后续适配包将无法作为当前适配包的覆盖更新安装。
