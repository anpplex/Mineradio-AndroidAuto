.class public final Lcom/mineradio/app/car/CarAudioFocusBridge;
.super Ljava/lang/Object;
.source "CarAudioFocusBridge.java"

# static fields
.field private static webViewRef:Ljava/lang/ref/WeakReference;
    .annotation system Ldalvik/annotation/Signature;
        value = {
            "Ljava/lang/ref/WeakReference<",
            "Landroid/webkit/WebView;",
            ">;"
        }
    .end annotation
.end field

# direct methods
.method private constructor <init>()V
    .locals 0

    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    return-void
.end method

.method public static attachWebView(Landroid/webkit/WebView;)V
    .locals 1

    if-nez p0, :cond_0

    return-void

    :cond_0
    new-instance v0, Ljava/lang/ref/WeakReference;

    invoke-direct {v0, p0}, Ljava/lang/ref/WeakReference;-><init>(Ljava/lang/Object;)V

    sput-object v0, Lcom/mineradio/app/car/CarAudioFocusBridge;->webViewRef:Ljava/lang/ref/WeakReference;

    return-void
.end method

.method public static onFocusChange(I)V
    .locals 4

    sget-object v0, Lcom/mineradio/app/car/CarAudioFocusBridge;->webViewRef:Ljava/lang/ref/WeakReference;

    if-nez v0, :cond_0

    return-void

    :cond_0
    invoke-virtual {v0}, Ljava/lang/ref/WeakReference;->get()Ljava/lang/Object;

    move-result-object v0

    check-cast v0, Landroid/webkit/WebView;

    if-nez v0, :cond_1

    return-void

    :cond_1
    new-instance v1, Ljava/lang/StringBuilder;

    const-string v2, "(function(c){try{if(window.MineradioCarVisual&&MineradioCarVisual.setAudioDuck){var d=(c===-1||c===-2||c===-3);MineradioCarVisual.setAudioDuck(!!d,\'native-af:\'+c);}}catch(e){}})("

    invoke-direct {v1, v2}, Ljava/lang/StringBuilder;-><init>(Ljava/lang/String;)V

    invoke-virtual {v1, p0}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;

    const-string v2, ");"

    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    invoke-virtual {v1}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;

    move-result-object v1

    new-instance v2, Lcom/mineradio/app/car/CarAudioFocusBridge$EvalJs;

    invoke-direct {v2, v0, v1}, Lcom/mineradio/app/car/CarAudioFocusBridge$EvalJs;-><init>(Landroid/webkit/WebView;Ljava/lang/String;)V

    invoke-virtual {v0, v2}, Landroid/webkit/WebView;->post(Ljava/lang/Runnable;)Z

    return-void
.end method
