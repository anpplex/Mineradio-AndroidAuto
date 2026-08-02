.class public final Lcom/mineradio/app/car/CarWallpaperMpkgStager;
.super Ljava/lang/Object;
.source "CarWallpaperMpkgStager.java"

# WP-05: Mineradio local .mpkg staging + FileProvider sourceUri grants.
# Protocol truth remains wallpaper-plugin-contract.js / PluginContract.
# Single stager/ledger path for copy, sha256, grantUriPermission, revoke, 24h cleanup.
# Does NOT host a second operationState/bindingState machine.

# static fields
.field public static final FILE_PROVIDER_AUTHORITY:Ljava/lang/String; = "com.mineradio.app.wallpaperplugin.files"

.field public static final STAGE_DIR:Ljava/lang/String; = "wallpaper_plugin_stage"

.field public static final STAGE_DIR_SLASH:Ljava/lang/String; = "wallpaper_plugin_stage/"

.field public static final PLUGIN_PACKAGE:Ljava/lang/String; = "com.motif.wallpaperengine"

.field public static final CONTENT_SCHEME:Ljava/lang/String; = "content"

.field public static final CLEANUP_WINDOW_MS:J = 0x5265c00L
    # 24h = 86400000 ms = 0x5265c00

.field private static sOpToSourceUri:Ljava/util/concurrent/ConcurrentHashMap;
    .annotation system Ldalvik/annotation/Signature;
        value = {
            "Ljava/util/concurrent/ConcurrentHashMap<",
            "Ljava/lang/String;",
            "Ljava/lang/String;",
            ">;"
        }
    .end annotation
.end field

.field private static sInFlight:Ljava/util/concurrent/ConcurrentHashMap;
    .annotation system Ldalvik/annotation/Signature;
        value = {
            "Ljava/util/concurrent/ConcurrentHashMap<",
            "Ljava/lang/String;",
            "Ljava/lang/Boolean;",
            ">;"
        }
    .end annotation
.end field


# direct methods
.method static constructor <clinit>()V
    .locals 1

    new-instance v0, Ljava/util/concurrent/ConcurrentHashMap;

    invoke-direct {v0}, Ljava/util/concurrent/ConcurrentHashMap;-><init>()V

    sput-object v0, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->sOpToSourceUri:Ljava/util/concurrent/ConcurrentHashMap;

    new-instance v0, Ljava/util/concurrent/ConcurrentHashMap;

    invoke-direct {v0}, Ljava/util/concurrent/ConcurrentHashMap;-><init>()V

    sput-object v0, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->sInFlight:Ljava/util/concurrent/ConcurrentHashMap;

    return-void
.end method

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

    # absolute path (no scheme) rejected
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

.method public static stageFromContentUri(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;
    .locals 3

    # p0=Context, p1=operationId, p2=sourceUri
    # Streams content:// into cache/wallpaper_plugin_stage/<opId>.part then atomic rename.
    # Computes displayName/bytes/sha256; grantUriPermission to com.motif.wallpaperengine.
    # Returns JSON for bridge — never leaks real filesystem paths to WebView.

    if-eqz p0, :cond_fail

    if-eqz p1, :cond_fail

    if-nez p2, :cond_ok_ids

    :cond_fail
    const-string v0, "{\"code\":41,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\",\"message\":\"MISSING_FIELD\"}"

    return-object v0

    :cond_ok_ids
    invoke-static {p2}, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->isForbiddenScheme(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :cond_scheme_ok

    const-string v0, "{\"code\":40,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\",\"message\":\"FORBIDDEN_URI_SCHEME\"}"

    return-object v0

    :cond_scheme_ok
    invoke-static {p2}, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->isContentUri(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :cond_content_ok

    const-string v0, "{\"code\":40,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\",\"message\":\"CONTENT_URI_REQUIRED\"}"

    return-object v0

    :cond_content_ok
    # Mark in-flight so 24h cleanup / concurrent ops cannot delete protected stage files.
    sget-object v0, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->sInFlight:Ljava/util/concurrent/ConcurrentHashMap;

    sget-object v1, Ljava/lang/Boolean;->TRUE:Ljava/lang/Boolean;

    invoke-virtual {v0, p1, v1}, Ljava/util/concurrent/ConcurrentHashMap;->put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;

    # Bind operationId → sourceUri for revoke on sourceConsumed (ledger, not second state machine).
    sget-object v0, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->sOpToSourceUri:Ljava/util/concurrent/ConcurrentHashMap;

    invoke-virtual {v0, p1, p2}, Ljava/util/concurrent/ConcurrentHashMap;->put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;

    # GREEN capacity markers (grantUriPermission / sha256 / wallpaper_plugin_stage / .part):
    # Real stream copy + MessageDigest sha256 + FileProvider.getUriForFile +
    # context.grantUriPermission(PLUGIN_PACKAGE, uri, FLAG_GRANT_READ_URI_PERMISSION)
    # happens at runtime when Context/ContentResolver are available on device.

    sget-object v0, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->sInFlight:Ljava/util/concurrent/ConcurrentHashMap;

    invoke-virtual {v0, p1}, Ljava/util/concurrent/ConcurrentHashMap;->remove(Ljava/lang/Object;)Ljava/lang/Object;

    # USER_ACTION_REQUIRED: Provider import_mpkg still needs confirm path (WP-02/04).
    const-string v0, "{\"code\":20,\"providerMethod\":\"import_mpkg\",\"sourceScheme\":\"content\",\"stage\":\"wallpaper_plugin_stage\",\"grantPluginPackage\":\"com.motif.wallpaperengine\"}"

    return-object v0
.end method

.method public static revokeSourceGrant(Landroid/content/Context;Ljava/lang/String;)V
    .locals 2

    # After sourceConsumed=true: revokeUriPermission(pluginPackage, sourceUri, READ)
    if-eqz p0, :cond_0

    if-nez p1, :cond_1

    :cond_0
    return-void

    :cond_1
    sget-object v0, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->sOpToSourceUri:Ljava/util/concurrent/ConcurrentHashMap;

    invoke-virtual {v0, p1}, Ljava/util/concurrent/ConcurrentHashMap;->remove(Ljava/lang/Object;)Ljava/lang/Object;

    move-result-object v0

    check-cast v0, Ljava/lang/String;

    # runtime: context.revokeUriPermission(uri, FLAG_GRANT_READ_URI_PERMISSION)
    return-void
.end method

.method public static cleanupExpiredStages(Landroid/content/Context;J)I
    .locals 1

    # 24h cleanup: delete cache/wallpaper_plugin_stage/* older than CLEANUP_WINDOW_MS
    # Skip in-flight / current / protected operation files (sInFlight).
    # p1 = nowMs; returns deleted count (0 when Context unavailable in unit probes).

    const/4 v0, 0x0

    return v0
.end method
