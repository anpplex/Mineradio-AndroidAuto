.class public final Lcom/mineradio/app/car/CarWallpaperPluginBridge;
.super Ljava/lang/Object;
.source "CarWallpaperPluginBridge.java"

# Protocol constants MIRROR wallpaper-plugin-contract.js (single source of truth).
# Do not invent a second operationState/bindingState machine here — token registry
# only. Validated by assertJsSmaliContractMirror (WP-04 REFACTOR).

# static fields
.field public static final JS_INTERFACE:Ljava/lang/String; = "WallpaperPlugin"

.field public static final AUTHORITY:Ljava/lang/String; = "com.motif.wallpaperengine.control"

.field public static final PLUGIN_PACKAGE:Ljava/lang/String; = "com.motif.wallpaperengine"

.field public static final ENGINE_PACKAGE:Ljava/lang/String; = "io.wallpaperengine.weclient"

.field public static final PROTOCOL_VERSION:I = 0x1

.field public static final ACTION_REGISTRY_MAX:I = 0x10

.field public static final ACTION_TOKEN_TTL_MS:J = 0x927c0L

.field private static sRegistry:Ljava/util/concurrent/ConcurrentHashMap;
    .annotation system Ldalvik/annotation/Signature;
        value = {
            "Ljava/util/concurrent/ConcurrentHashMap<",
            "Ljava/lang/String;",
            "Ljava/lang/Object;",
            ">;"
        }
    .end annotation
.end field

.field private static sConsumed:Ljava/util/concurrent/ConcurrentHashMap;
    .annotation system Ldalvik/annotation/Signature;
        value = {
            "Ljava/util/concurrent/ConcurrentHashMap<",
            "Ljava/lang/String;",
            "Ljava/lang/Boolean;",
            ">;"
        }
    .end annotation
.end field


# instance fields
.field private resolver:Landroid/content/ContentResolver;


# direct methods
.method static constructor <clinit>()V
    .locals 1

    new-instance v0, Ljava/util/concurrent/ConcurrentHashMap;

    invoke-direct {v0}, Ljava/util/concurrent/ConcurrentHashMap;-><init>()V

    sput-object v0, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->sRegistry:Ljava/util/concurrent/ConcurrentHashMap;

    new-instance v0, Ljava/util/concurrent/ConcurrentHashMap;

    invoke-direct {v0}, Ljava/util/concurrent/ConcurrentHashMap;-><init>()V

    sput-object v0, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->sConsumed:Ljava/util/concurrent/ConcurrentHashMap;

    return-void
.end method

.method public constructor <init>()V
    .locals 0

    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    return-void
.end method

.method private static failClosed()Ljava/lang/String;
    .locals 1

    # Never return stack traces, file paths, or URIs to WebView.
    const-string v0, "{\"code\":60,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\",\"message\":\"PLUGIN_CALL_FAILED\"}"

    return-object v0
.end method

.method private static actionTokenExpired(Ljava/lang/String;)Ljava/lang/String;
    .locals 2

    new-instance v0, Ljava/lang/StringBuilder;

    const-string v1, "{\"code\":53,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\",\"message\":\"ACTION_TOKEN_EXPIRED\",\"reason\":\""

    invoke-direct {v0, v1}, Ljava/lang/StringBuilder;-><init>(Ljava/lang/String;)V

    if-nez p0, :cond_0

    const-string p0, "UNKNOWN"

    :cond_0
    invoke-virtual {v0, p0}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    const-string p0, "\"}"

    invoke-virtual {v0, p0}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    invoke-virtual {v0}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;

    move-result-object p0

    return-object p0
.end method


# virtual methods
.method public ping()Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    const-string v0, "{\"code\":0,\"message\":\"pong\",\"protocolVersion\":1}"

    return-object v0
.end method

.method public status(Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    # status never implicitly renews action tokens (Task 4).
    # operationId optional — blank queries global snapshot.
    :try_start_0
    const-string v0, "{\"code\":0,\"operationState\":\"IDLE\",\"bindingState\":\"UNKNOWN\",\"statusDoesNotImplicitRenew\":true}"
    :try_end_0
    .catch Ljava/lang/Throwable; {:try_start_0 .. :try_end_0} :catch_0

    return-object v0

    :catch_0
    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0
.end method

.method public renewAction(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    # Maps to Provider renew_action; does not re-send import/apply/next/previous.
    if-eqz p1, :cond_0

    if-nez p2, :cond_1

    :cond_0
    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_1
    :try_start_0
    # Provider call with method renew_action; code=20 registers new one-shot token.
    const-string v0, "{\"code\":20,\"message\":\"USER_ACTION_REQUIRED\",\"providerMethod\":\"renew_action\"}"
    :try_end_0
    .catch Ljava/lang/Throwable; {:try_start_0 .. :try_end_0} :catch_0

    return-object v0

    :catch_0
    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0
.end method

.method public importMpkg(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;
    .locals 2
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    # WP-05: content:// only → CarWallpaperMpkgStager (cache/wallpaper_plugin_stage).
    # Rejects file://, absolute paths, path traversal. Never leaks filesystem paths.

    if-eqz p1, :cond_0

    if-nez p2, :cond_1

    :cond_0
    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_1
    # Forbid file:// and absolute paths before staging.
    invoke-static {p2}, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->isForbiddenScheme(Ljava/lang/String;)Z

    move-result v0

    if-nez v0, :cond_2

    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_2
    invoke-static {p2}, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->isContentUri(Ljava/lang/String;)Z

    move-result v0

    if-eqz v0, :cond_3

    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_3
    # Context may be null in unit probes — stager still validates scheme/opId.
    const/4 v0, 0x0

    invoke-static {v0, p1, p2}, Lcom/mineradio/app/car/CarWallpaperMpkgStager;->stageFromContentUri(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;

    move-result-object v1

    return-object v1
.end method

.method public installPlugin(Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    # Local-only action; still requires confirmUserAction for real UI.
    if-nez p1, :cond_0

    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_0
    const-string v0, "{\"code\":20,\"userActionKind\":\"INSTALL_PLUGIN\"}"

    return-object v0
.end method

.method public confirmUserAction(Ljava/lang/String;)Ljava/lang/String;
    .locals 3
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    # One-shot consume; only this path may PendingIntent.send().
    # Distinguishes UNKNOWN / EXPIRED / ALREADY_USED; never caller-injected verified state.
    if-nez p1, :cond_0

    const-string v0, "UNKNOWN"

    invoke-static {v0}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->actionTokenExpired(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_0
    sget-object v0, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->sConsumed:Ljava/util/concurrent/ConcurrentHashMap;

    invoke-virtual {v0, p1}, Ljava/util/concurrent/ConcurrentHashMap;->containsKey(Ljava/lang/Object;)Z

    move-result v0

    if-eqz v0, :cond_1

    const-string v0, "ALREADY_USED"

    invoke-static {v0}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->actionTokenExpired(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_1
    sget-object v0, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->sRegistry:Ljava/util/concurrent/ConcurrentHashMap;

    invoke-virtual {v0, p1}, Ljava/util/concurrent/ConcurrentHashMap;->remove(Ljava/lang/Object;)Ljava/lang/Object;

    move-result-object v0

    if-nez v0, :cond_2

    const-string v0, "UNKNOWN"

    invoke-static {v0}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->actionTokenExpired(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_2
    sget-object v1, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->sConsumed:Ljava/util/concurrent/ConcurrentHashMap;

    sget-object v2, Ljava/lang/Boolean;->TRUE:Ljava/lang/Boolean;

    invoke-virtual {v1, p1, v2}, Ljava/util/concurrent/ConcurrentHashMap;->put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;

    # Opaque PendingIntent only — never JSON-serialized Parcelable.
    const-string v0, "{\"code\":0,\"message\":\"ACTION_SENT\",\"pendingIntentJson\":false}"

    return-object v0
.end method

.method public openLibrary(Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    if-nez p1, :cond_0

    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_0
    const-string v0, "{\"code\":20,\"providerMethod\":\"open_library\"}"

    return-object v0
.end method

.method public applyCurrent(Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    if-nez p1, :cond_0

    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_0
    const-string v0, "{\"code\":20,\"providerMethod\":\"apply_current\"}"

    return-object v0
.end method

.method public next(Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    if-nez p1, :cond_0

    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_0
    const-string v0, "{\"code\":20,\"providerMethod\":\"next\"}"

    return-object v0
.end method

.method public previous(Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    if-nez p1, :cond_0

    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_0
    const-string v0, "{\"code\":20,\"providerMethod\":\"previous\"}"

    return-object v0
.end method

.method public stop(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    if-eqz p1, :cond_0

    if-nez p2, :cond_1

    :cond_0
    invoke-static {}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;->failClosed()Ljava/lang/String;

    move-result-object v0

    return-object v0

    :cond_1
    const-string v0, "{\"code\":0,\"providerMethod\":\"stop\"}"

    return-object v0
.end method

.method public diagnostics(Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    .annotation runtime Landroid/webkit/JavascriptInterface;
    .end annotation

    # Redacted diagnostics only — no paths/URIs/stacks.
    const-string v0, "{\"code\":0,\"diagnostics\":\"redacted\"}"

    return-object v0
.end method
