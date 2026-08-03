.class public final Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;
.super Landroid/app/Activity;
.source "WallpaperPluginBridgeProbeActivity.java"


# static fields
.field public static final TAG:Ljava/lang/String; = "WallpaperPluginBridgeProbe"


# direct methods
.method public constructor <init>()V
    .locals 0

    .line 15
    invoke-direct {p0}, Landroid/app/Activity;-><init>()V

    return-void
.end method

.method private extra(Ljava/lang/String;)Ljava/lang/String;
    .locals 1

    .line 61
    invoke-virtual {p0}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->getIntent()Landroid/content/Intent;

    move-result-object v0

    if-nez v0, :cond_0

    const/4 p1, 0x0

    return-object p1

    .line 62
    :cond_0
    invoke-virtual {p0}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->getIntent()Landroid/content/Intent;

    move-result-object v0

    invoke-virtual {v0, p1}, Landroid/content/Intent;->getStringExtra(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p1

    return-object p1
.end method


# virtual methods
.method protected onCreate(Landroid/os/Bundle;)V
    .locals 7

    .line 20
    const-string v0, "WallpaperPluginBridgeProbe"

    invoke-super {p0, p1}, Landroid/app/Activity;->onCreate(Landroid/os/Bundle;)V

    .line 21
    invoke-virtual {p0}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->getIntent()Landroid/content/Intent;

    move-result-object p1

    if-eqz p1, :cond_0

    invoke-virtual {p0}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->getIntent()Landroid/content/Intent;

    move-result-object p1

    const-string v1, "method"

    invoke-virtual {p1, v1}, Landroid/content/Intent;->getStringExtra(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p1

    goto :goto_0

    :cond_0
    const/4 p1, 0x0

    .line 22
    :goto_0
    const-string v1, "ping"

    if-eqz p1, :cond_1

    invoke-virtual {p1}, Ljava/lang/String;->isEmpty()Z

    move-result v2

    if-eqz v2, :cond_2

    .line 23
    :cond_1
    move-object p1, v1

    .line 27
    :cond_2
    :try_start_0
    invoke-virtual {p1}, Ljava/lang/String;->hashCode()I

    move-result v2

    const/4 v3, 0x1

    sparse-switch v2, :sswitch_data_0

    :cond_3
    goto :goto_1

    :sswitch_0
    const-string v1, "import_mpkg"

    invoke-virtual {p1, v1}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z

    move-result v1

    if-eqz v1, :cond_3

    move v1, v3

    goto :goto_2

    :sswitch_1
    const-string v1, "renew_action"

    invoke-virtual {p1, v1}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z

    move-result v1

    if-eqz v1, :cond_3

    const/4 v1, 0x2

    goto :goto_2

    :sswitch_2
    invoke-virtual {p1, v1}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z

    move-result v1

    if-eqz v1, :cond_3

    const/4 v1, 0x3

    goto :goto_2

    :sswitch_3
    const-string v1, "status"

    invoke-virtual {p1, v1}, Ljava/lang/String;->equals(Ljava/lang/Object;)Z

    move-result v1
    :try_end_0
    .catchall {:try_start_0 .. :try_end_0} :catchall_0

    if-eqz v1, :cond_3

    const/4 v1, 0x0

    goto :goto_2

    :goto_1
    const/4 v1, -0x1

    :goto_2
    const-string v2, "operationId"

    packed-switch v1, :pswitch_data_0

    .line 47
    :try_start_1
    invoke-static {}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->ping()Ljava/lang/String;

    move-result-object v1

    goto :goto_3

    .line 40
    :pswitch_0
    nop

    .line 41
    invoke-direct {p0, v2}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->extra(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v1

    const-string v2, "actionToken"

    .line 42
    invoke-direct {p0, v2}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->extra(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v2

    .line 43
    invoke-virtual {p0}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->getIntent()Landroid/content/Intent;

    move-result-object v4

    const-string v5, "actionEpoch"

    invoke-virtual {v4, v5, v3}, Landroid/content/Intent;->getIntExtra(Ljava/lang/String;I)I

    move-result v3

    .line 40
    invoke-static {v1, v2, v3}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->renewAction(Ljava/lang/String;Ljava/lang/String;I)Ljava/lang/String;

    move-result-object v1

    .line 44
    goto :goto_3

    .line 33
    :pswitch_1
    nop

    .line 34
    invoke-direct {p0, v2}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->extra(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v1

    const-string v2, "sourceUri"

    .line 35
    invoke-direct {p0, v2}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->extra(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v2

    .line 36
    invoke-virtual {p0}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->getIntent()Landroid/content/Intent;

    move-result-object v3

    const-string v4, "bytes"

    const-wide/16 v5, 0x1

    invoke-virtual {v3, v4, v5, v6}, Landroid/content/Intent;->getLongExtra(Ljava/lang/String;J)J

    move-result-wide v3

    const-string v5, "sha256"

    .line 37
    invoke-direct {p0, v5}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->extra(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v5

    .line 33
    invoke-static {v1, v2, v3, v4, v5}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->importMpkg(Ljava/lang/String;Ljava/lang/String;JLjava/lang/String;)Ljava/lang/String;

    move-result-object v1

    .line 38
    goto :goto_3

    .line 29
    :pswitch_2
    nop

    .line 30
    invoke-direct {p0, v2}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->extra(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v1

    .line 29
    invoke-static {v1}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->status(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v1
    :try_end_1
    .catchall {:try_start_1 .. :try_end_1} :catchall_0

    .line 31
    nop

    .line 53
    :goto_3
    goto :goto_4

    .line 50
    :catchall_0
    move-exception v1

    .line 51
    const-string v2, "PROBE_EXCEPTION"

    invoke-static {v2}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->failClosed(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v2

    .line 52
    const-string v3, "probe failed"

    invoke-static {v0, v3, v1}, Landroid/util/Log;->e(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)I

    move-object v1, v2

    .line 54
    :goto_4
    new-instance v2, Ljava/lang/StringBuilder;

    invoke-direct {v2}, Ljava/lang/StringBuilder;-><init>()V

    const-string v3, "method="

    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object v2

    invoke-virtual {v2, p1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object p1

    const-string v2, " result="

    invoke-virtual {p1, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object p1

    invoke-virtual {p1, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object p1

    invoke-virtual {p1}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;

    move-result-object p1

    invoke-static {v0, p1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I

    .line 56
    sget-object p1, Ljava/lang/System;->out:Ljava/io/PrintStream;

    new-instance v0, Ljava/lang/StringBuilder;

    invoke-direct {v0}, Ljava/lang/StringBuilder;-><init>()V

    const-string v2, "WallpaperPluginBridgeProbe "

    invoke-virtual {v0, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object v0

    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object v0

    invoke-virtual {v0}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;

    move-result-object v0

    invoke-virtual {p1, v0}, Ljava/io/PrintStream;->println(Ljava/lang/String;)V

    .line 57
    invoke-virtual {p0}, Lcom/mineradio/app/car/WallpaperPluginBridgeProbeActivity;->finish()V

    .line 58
    return-void

    :sswitch_data_0
    .sparse-switch
        -0x3532300e -> :sswitch_3
        0x348172 -> :sswitch_2
        0x382fe828 -> :sswitch_1
        0x578c0299 -> :sswitch_0
    .end sparse-switch

    :pswitch_data_0
    .packed-switch 0x0
        :pswitch_2
        :pswitch_1
        :pswitch_0
    .end packed-switch
.end method
