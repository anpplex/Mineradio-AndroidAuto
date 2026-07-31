.class final Lcom/mineradio/app/car/CarAudioFocusBridge$EvalJs;
.super Ljava/lang/Object;
.source "CarAudioFocusBridge.java"

# interfaces
.implements Ljava/lang/Runnable;

# instance fields
.field private final js:Ljava/lang/String;

.field private final webView:Landroid/webkit/WebView;

# direct methods
.method constructor <init>(Landroid/webkit/WebView;Ljava/lang/String;)V
    .locals 0

    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    iput-object p1, p0, Lcom/mineradio/app/car/CarAudioFocusBridge$EvalJs;->webView:Landroid/webkit/WebView;

    iput-object p2, p0, Lcom/mineradio/app/car/CarAudioFocusBridge$EvalJs;->js:Ljava/lang/String;

    return-void
.end method

# virtual methods
.method public run()V
    .locals 3

    :try_start_0
    iget-object v0, p0, Lcom/mineradio/app/car/CarAudioFocusBridge$EvalJs;->webView:Landroid/webkit/WebView;

    iget-object v1, p0, Lcom/mineradio/app/car/CarAudioFocusBridge$EvalJs;->js:Ljava/lang/String;

    const/4 v2, 0x0

    invoke-virtual {v0, v1, v2}, Landroid/webkit/WebView;->evaluateJavascript(Ljava/lang/String;Landroid/webkit/ValueCallback;)V
    :try_end_0
    .catchall {:try_start_0 .. :try_end_0} :catchall_0

    :catchall_0
    return-void
.end method
