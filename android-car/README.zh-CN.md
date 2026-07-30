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

1. 确认目标是 64 位 ARM：

   ```sh
   adb shell getprop ro.build.version.release
   adb shell getprop ro.product.cpu.abilist
   ```

   预期 Android 版本为 `12`，并且 ABI 列表包含 `arm64-v8a`。此 APK 不含 32 位 `armeabi-v7a` 或 x86 native libraries。

2. 由于适配包使用本机生成的新签名证书，如车机已安装同包名 `com.mineradio.app`、但签名证书不同的版本，先在车机上卸载旧版本：

   ```sh
   adb uninstall com.mineradio.app
   ```

3. 安装：

   ```sh
   adb install /absolute/path/to/Mineradio-1.1.7.0-huawei-android12-car.apk
   ```

4. 首次运行后，在系统设置中允许：
   - 音乐与音频文件读取权限；
   - 若需要访问 U 盘或共享存储根目录，允许“所有文件访问”；
   - 若播放在熄屏/休眠后被系统终止，将应用加入电池优化白名单。

5. 如车机 Launcher 未显示图标，先验证明确组件启动：

   ```sh
   adb shell am start -n com.mineradio.app/.LandscapeWebActivity
   ```

   能启动但未显示图标时，问题在 OEM Launcher 的第三方应用显示策略，不应通过修改系统分区或伪造系统签名处理。

## 复现构建

依赖：JDK 17+、Android build-tools（含 `aapt` 与 `apksigner`）、APKTool `2.11.1`。

```sh
export JAVA_HOME=/path/to/jdk
export APKTOOL_JAR=/absolute/path/to/apktool_2.11.1.jar
export MINERADIO_CAR_KEYSTORE_PASSWORD='choose-a-local-secret'
./android-car/scripts/build-car-apk.sh /absolute/path/to/Mineradio_1.1.7.0.apk
```

构建签名密钥保存在 `android-car/.signing/`，已被 Git 忽略。请安全备份该密钥；丢失它后，后续适配包将无法作为当前适配包的覆盖更新安装。
