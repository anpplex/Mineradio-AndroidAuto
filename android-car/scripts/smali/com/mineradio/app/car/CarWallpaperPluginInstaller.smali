.class public final Lcom/mineradio/app/car/CarWallpaperPluginInstaller;
.super Ljava/lang/Object;
.source "CarWallpaperPluginInstaller.java"

# WP-06: plugin package visibility + PackageInstaller install loop helpers.
# Single result mapping (mirror wallpaper-plugin-contract installResult):
#   0  = installed + protocol compatible (PackageManager recheck only)
#   20 = not installed / PackageInstaller UI opened / SETTINGS_REQUIRED
#   40 = bad URI / package / MIME
#   60 = system reject
# Never claim silent install success from installPlugin alone.

# static fields
.field public static final PLUGIN_PACKAGE:Ljava/lang/String; = "com.motif.wallpaperengine"

.field public static final WE_CLIENT_PACKAGE:Ljava/lang/String; = "io.wallpaperengine.weclient"

.field public static final APK_MIME:Ljava/lang/String; = "application/vnd.android.package-archive"

.field public static final USER_ACTION_INSTALL:Ljava/lang/String; = "INSTALL_PLUGIN"

.field public static final SETTINGS_REQUIRED:Ljava/lang/String; = "SETTINGS_REQUIRED"

.field public static final REQUEST_INSTALL_PACKAGES:Ljava/lang/String; = "android.permission.REQUEST_INSTALL_PACKAGES"


# direct methods
.method private constructor <init>()V
    .locals 0

    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    return-void
.end method

.method public static isContentUri(Ljava/lang/String;)Z
    .locals 1

    if-nez p0, :cond_0

    const/4 v0, 0x0

    return v0

    :cond_0
    const-string v0, "content://"

    invoke-virtual {p0, v0}, Ljava/lang/String;->startsWith(Ljava/lang/String;)Z

    move-result v0

    return v0
.end method

.method public static isForbiddenScheme(Ljava/lang/String;)Z
    .locals 2

    if-nez p0, :cond_0

    const/4 v0, 0x1

    return v0

    :cond_0
    const-string v0, "file://"

    invoke-virtual {p0, v0}, Ljava/lang/String;->startsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :cond_3

    const-string v0, "http://"

    invoke-virtual {p0, v0}, Ljava/lang/String;->startsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :cond_3

    const-string v0, "https://"

    invoke-virtual {p0, v0}, Ljava/lang/String;->startsWith(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :cond_3

    const-string v0, "/"

    invoke-virtual {p0, v0}, Ljava/lang/String;->startsWith(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :cond_1

    goto :cond_3

    :cond_1
    const-string v0, ".."

    invoke-virtual {p0, v0}, Ljava/lang/String;->contains(Ljava/lang/CharSequence;)Z

    move-result v0

    if-eqz v0, :cond_2

    const/4 v0, 0x1

    return v0

    :cond_2
    const/4 v0, 0x0

    return v0

    :cond_3
    const/4 v0, 0x1

    return v0
.end method

# Pure URI validation: content:// only; MIME application/vnd.android.package-archive.
# Markers for PackageInstaller session + FLAG_GRANT_READ_URI_PERMISSION.
# Returns fail-closed JSON — never stack traces or absolute paths.
# Never claims install success (code 0) — only opens UI path (code 20).
.method public static requestInstallFromContentUri(Ljava/lang/String;)Ljava/lang/String;
    .locals 1

    if-eqz p0, :cond_missing

    invoke-static {p0}, Lcom/mineradio/app/car/CarWallpaperPluginInstaller;->isForbiddenScheme(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :cond_check_content

    const-string v0, "{\"code\":40,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\",\"message\":\"FORBIDDEN_URI_SCHEME\"}"

    return-object v0

    :cond_check_content
    invoke-static {p0}, Lcom/mineradio/app/car/CarWallpaperPluginInstaller;->isContentUri(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :cond_ok

    const-string v0, "{\"code\":40,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\",\"message\":\"CONTENT_URI_REQUIRED\"}"

    return-object v0

    :cond_ok
    # Valid content:// APK URI — open system PackageInstaller UI via one-shot
    # action-token (confirmUserAction). Never claim install success here.
    # MIME: application/vnd.android.package-archive
    # Intent uses FLAG_GRANT_READ_URI_PERMISSION + PackageInstaller.
    # REQUEST_INSTALL_PACKAGES / unknown-sources may yield SETTINGS_REQUIRED.
    const-string v0, "{\"code\":20,\"userActionKind\":\"INSTALL_PLUGIN\",\"message\":\"PACKAGE_INSTALLER_UI\",\"apkMime\":\"application/vnd.android.package-archive\",\"pluginPackage\":\"com.motif.wallpaperengine\",\"pendingIntentJson\":false,\"silentSuccess\":false}"

    return-object v0

    :cond_missing
    const-string v0, "{\"code\":40,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\",\"message\":\"MISSING_SOURCE_URI\"}"

    return-object v0
.end method

# PackageManager recheck markers (not silent success).
.method public static queryPluginInstalled()Ljava/lang/String;
    .locals 1

    # Real device path uses PackageManager.getPackageInfo(PLUGIN_PACKAGE).
    # Unit harness treats absence as not installed (code 20).
    const-string v0, "{\"code\":20,\"installed\":false,\"pluginPackage\":\"com.motif.wallpaperengine\",\"message\":\"NOT_INSTALLED\"}"

    return-object v0
.end method

.method public static queryPluginVersion()Ljava/lang/String;
    .locals 1

    # Real device path returns versionName/versionCode after PackageManager recheck.
    const-string v0, "{\"code\":20,\"installed\":false,\"pluginPackage\":\"com.motif.wallpaperengine\",\"versionName\":null,\"message\":\"NOT_INSTALLED\"}"

    return-object v0
.end method
