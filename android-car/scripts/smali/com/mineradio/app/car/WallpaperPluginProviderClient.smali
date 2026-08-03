.class public final Lcom/mineradio/app/car/WallpaperPluginProviderClient;
.super Ljava/lang/Object;
.source "WallpaperPluginProviderClient.java"


# static fields
.field public static final AUTHORITY:Ljava/lang/String; = "com.motif.wallpaperengine.control"

.field public static final CONTROL_URI:Landroid/net/Uri;

.field public static final PROTOCOL_VERSION:I = 0x1


# direct methods
.method static constructor <clinit>()V
    .locals 1

    .line 20
    const-string v0, "content://com.motif.wallpaperengine.control"

    invoke-static {v0}, Landroid/net/Uri;->parse(Ljava/lang/String;)Landroid/net/Uri;

    move-result-object v0

    sput-object v0, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->CONTROL_URI:Landroid/net/Uri;

    return-void
.end method

.method private constructor <init>()V
    .locals 0

    .line 23
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    return-void
.end method

.method public static appContext()Landroid/content/Context;
    .locals 5

    .line 28
    const/4 v0, 0x0

    :try_start_0
    const-string v1, "android.app.ActivityThread"

    invoke-static {v1}, Ljava/lang/Class;->forName(Ljava/lang/String;)Ljava/lang/Class;

    move-result-object v1

    .line 29
    const-string v2, "currentApplication"

    const/4 v3, 0x0

    new-array v4, v3, [Ljava/lang/Class;

    invoke-virtual {v1, v2, v4}, Ljava/lang/Class;->getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;

    move-result-object v1

    new-array v2, v3, [Ljava/lang/Object;

    invoke-virtual {v1, v0, v2}, Ljava/lang/reflect/Method;->invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;

    move-result-object v1

    .line 30
    instance-of v2, v1, Landroid/content/Context;

    if-eqz v2, :cond_0

    .line 31
    check-cast v1, Landroid/content/Context;

    invoke-virtual {v1}, Landroid/content/Context;->getApplicationContext()Landroid/content/Context;

    move-result-object v0
    :try_end_0
    .catchall {:try_start_0 .. :try_end_0} :catchall_0

    return-object v0

    .line 35
    :cond_0
    goto :goto_0

    .line 33
    :catchall_0
    move-exception v1

    .line 36
    :goto_0
    return-object v0
.end method

.method private static appendJsonValue(Ljava/lang/StringBuilder;Ljava/lang/Object;)V
    .locals 4

    .line 151
    if-nez p1, :cond_0

    .line 152
    const-string p1, "null"

    invoke-virtual {p0, p1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    goto/16 :goto_3

    .line 153
    :cond_0
    instance-of v0, p1, Ljava/lang/Boolean;

    if-eqz v0, :cond_2

    .line 154
    check-cast p1, Ljava/lang/Boolean;

    invoke-virtual {p1}, Ljava/lang/Boolean;->booleanValue()Z

    move-result p1

    if-eqz p1, :cond_1

    const-string p1, "true"

    goto :goto_0

    :cond_1
    const-string p1, "false"

    :goto_0
    invoke-virtual {p0, p1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    goto/16 :goto_3

    .line 155
    :cond_2
    instance-of v0, p1, Ljava/lang/Integer;

    if-eqz v0, :cond_3

    .line 156
    check-cast p1, Ljava/lang/Integer;

    invoke-virtual {p1}, Ljava/lang/Integer;->intValue()I

    move-result p1

    invoke-virtual {p0, p1}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;

    goto/16 :goto_3

    .line 157
    :cond_3
    instance-of v0, p1, Ljava/lang/Long;

    if-eqz v0, :cond_4

    .line 158
    check-cast p1, Ljava/lang/Long;

    invoke-virtual {p1}, Ljava/lang/Long;->longValue()J

    move-result-wide v0

    invoke-virtual {p0, v0, v1}, Ljava/lang/StringBuilder;->append(J)Ljava/lang/StringBuilder;

    goto/16 :goto_3

    .line 159
    :cond_4
    instance-of v0, p1, Ljava/lang/Float;

    if-eqz v0, :cond_5

    .line 160
    check-cast p1, Ljava/lang/Float;

    invoke-virtual {p1}, Ljava/lang/Float;->floatValue()F

    move-result p1

    invoke-virtual {p0, p1}, Ljava/lang/StringBuilder;->append(F)Ljava/lang/StringBuilder;

    goto/16 :goto_3

    .line 161
    :cond_5
    instance-of v0, p1, Ljava/lang/Double;

    if-eqz v0, :cond_6

    .line 162
    check-cast p1, Ljava/lang/Double;

    invoke-virtual {p1}, Ljava/lang/Double;->doubleValue()D

    move-result-wide v0

    invoke-virtual {p0, v0, v1}, Ljava/lang/StringBuilder;->append(D)Ljava/lang/StringBuilder;

    goto :goto_3

    .line 163
    :cond_6
    instance-of v0, p1, Ljava/lang/String;

    const/16 v1, 0x22

    if-eqz v0, :cond_7

    .line 164
    invoke-virtual {p0, v1}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    move-result-object p0

    check-cast p1, Ljava/lang/String;

    invoke-static {p1}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->jsonEscape(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p1

    invoke-virtual {p0, p1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object p0

    invoke-virtual {p0, v1}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    goto :goto_3

    .line 165
    :cond_7
    instance-of v0, p1, [Ljava/lang/String;

    if-eqz v0, :cond_b

    .line 166
    check-cast p1, [Ljava/lang/String;

    .line 167
    const/16 v0, 0x5b

    invoke-virtual {p0, v0}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 168
    const/4 v0, 0x0

    :goto_1
    array-length v2, p1

    if-ge v0, v2, :cond_a

    .line 169
    if-lez v0, :cond_8

    const/16 v2, 0x2c

    invoke-virtual {p0, v2}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 170
    :cond_8
    invoke-virtual {p0, v1}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    move-result-object v2

    aget-object v3, p1, v0

    if-nez v3, :cond_9

    const-string v3, ""

    goto :goto_2

    :cond_9
    aget-object v3, p1, v0

    :goto_2
    invoke-static {v3}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->jsonEscape(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v3

    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object v2

    invoke-virtual {v2, v1}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 168
    add-int/lit8 v0, v0, 0x1

    goto :goto_1

    .line 172
    :cond_a
    const/16 p1, 0x5d

    invoke-virtual {p0, p1}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 173
    goto :goto_3

    .line 174
    :cond_b
    invoke-virtual {p0, v1}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    move-result-object p0

    invoke-static {p1}, Ljava/lang/String;->valueOf(Ljava/lang/Object;)Ljava/lang/String;

    move-result-object p1

    invoke-static {p1}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->jsonEscape(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p1

    invoke-virtual {p0, p1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object p0

    invoke-virtual {p0, v1}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 176
    :goto_3
    return-void
.end method

.method private static baseExtras(Ljava/lang/String;)Landroid/os/Bundle;
    .locals 3

    .line 110
    new-instance v0, Landroid/os/Bundle;

    invoke-direct {v0}, Landroid/os/Bundle;-><init>()V

    .line 111
    const-string v1, "protocolVersion"

    const/4 v2, 0x1

    invoke-virtual {v0, v1, v2}, Landroid/os/Bundle;->putInt(Ljava/lang/String;I)V

    .line 112
    const-string v1, "callId"

    invoke-virtual {v0, v1, p0}, Landroid/os/Bundle;->putString(Ljava/lang/String;Ljava/lang/String;)V

    .line 113
    return-object v0
.end method

.method static bundleToJson(Landroid/os/Bundle;)Ljava/lang/String;
    .locals 6

    .line 129
    new-instance v0, Ljava/lang/StringBuilder;

    const/16 v1, 0x100

    invoke-direct {v0, v1}, Ljava/lang/StringBuilder;-><init>(I)V

    .line 130
    const/16 v1, 0x7b

    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 132
    const-string v1, "\"realCallerPid\":"

    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object v1

    invoke-static {}, Landroid/os/Process;->myPid()I

    move-result v2

    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;

    .line 133
    const-string v1, ",\"realCallerUid\":"

    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object v1

    invoke-static {}, Landroid/os/Process;->myUid()I

    move-result v2

    invoke-virtual {v1, v2}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;

    .line 134
    const-string v1, ",\"realCaller\":true"

    invoke-virtual {v0, v1}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    .line 136
    invoke-virtual {p0}, Landroid/os/Bundle;->keySet()Ljava/util/Set;

    move-result-object v1

    .line 137
    if-eqz v1, :cond_1

    .line 138
    invoke-interface {v1}, Ljava/util/Set;->iterator()Ljava/util/Iterator;

    move-result-object v1

    :goto_0
    invoke-interface {v1}, Ljava/util/Iterator;->hasNext()Z

    move-result v2

    if-eqz v2, :cond_1

    invoke-interface {v1}, Ljava/util/Iterator;->next()Ljava/lang/Object;

    move-result-object v2

    check-cast v2, Ljava/lang/String;

    .line 139
    if-nez v2, :cond_0

    goto :goto_0

    .line 140
    :cond_0
    invoke-virtual {p0, v2}, Landroid/os/Bundle;->get(Ljava/lang/String;)Ljava/lang/Object;

    move-result-object v3

    .line 141
    const/16 v4, 0x2c

    invoke-virtual {v0, v4}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 142
    const/16 v4, 0x22

    invoke-virtual {v0, v4}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    move-result-object v5

    invoke-static {v2}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->jsonEscape(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v2

    invoke-virtual {v5, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object v2

    invoke-virtual {v2, v4}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    move-result-object v2

    const/16 v4, 0x3a

    invoke-virtual {v2, v4}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 143
    invoke-static {v0, v3}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->appendJsonValue(Ljava/lang/StringBuilder;Ljava/lang/Object;)V

    .line 144
    goto :goto_0

    .line 146
    :cond_1
    const/16 p0, 0x7d

    invoke-virtual {v0, p0}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 147
    invoke-virtual {v0}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;

    move-result-object p0

    return-object p0
.end method

.method public static call(Ljava/lang/String;Landroid/os/Bundle;)Ljava/lang/String;
    .locals 3

    .line 90
    invoke-static {}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->appContext()Landroid/content/Context;

    move-result-object v0

    .line 91
    if-nez v0, :cond_0

    .line 92
    const-string p0, "NO_APPLICATION"

    invoke-static {p0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->failClosed(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p0

    return-object p0

    .line 94
    :cond_0
    invoke-virtual {v0}, Landroid/content/Context;->getContentResolver()Landroid/content/ContentResolver;

    move-result-object v0

    .line 95
    if-nez v0, :cond_1

    .line 96
    const-string p0, "NO_RESOLVER"

    invoke-static {p0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->failClosed(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p0

    return-object p0

    .line 99
    :cond_1
    :try_start_0
    sget-object v1, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->CONTROL_URI:Landroid/net/Uri;

    const/4 v2, 0x0

    invoke-virtual {v0, v1, p0, v2, p1}, Landroid/content/ContentResolver;->call(Landroid/net/Uri;Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;

    move-result-object p0

    .line 100
    if-nez p0, :cond_2

    .line 101
    const-string p0, "NULL_BUNDLE"

    invoke-static {p0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->failClosed(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p0

    return-object p0

    .line 103
    :cond_2
    invoke-static {p0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->bundleToJson(Landroid/os/Bundle;)Ljava/lang/String;

    move-result-object p0
    :try_end_0
    .catchall {:try_start_0 .. :try_end_0} :catchall_0

    return-object p0

    .line 104
    :catchall_0
    move-exception p0

    .line 105
    const-string p0, "PLUGIN_CALL_FAILED"

    invoke-static {p0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->failClosed(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p0

    return-object p0
.end method

.method static failClosed(Ljava/lang/String;)Ljava/lang/String;
    .locals 4

    .line 117
    nop

    .line 119
    invoke-static {p0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->jsonEscape(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p0

    .line 121
    invoke-static {}, Landroid/os/Process;->myPid()I

    move-result v0

    .line 123
    invoke-static {}, Landroid/os/Process;->myUid()I

    move-result v1

    new-instance v2, Ljava/lang/StringBuilder;

    invoke-direct {v2}, Ljava/lang/StringBuilder;-><init>()V

    const-string v3, "{\"code\":60,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\",\"message\":\"PLUGIN_CALL_FAILED\",\"reason\":\""

    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object v2

    invoke-virtual {v2, p0}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object p0

    const-string v2, "\",\"realCallerPid\":"

    invoke-virtual {p0, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object p0

    invoke-virtual {p0, v0}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;

    move-result-object p0

    const-string v0, ",\"realCallerUid\":"

    invoke-virtual {p0, v0}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object p0

    invoke-virtual {p0, v1}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;

    move-result-object p0

    const-string v0, "}"

    invoke-virtual {p0, v0}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    move-result-object p0

    invoke-virtual {p0}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;

    move-result-object p0

    .line 117
    return-object p0
.end method

.method public static importMpkg(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;
    .locals 3

    .line 71
    const-wide/16 v0, 0x1

    const/4 v2, 0x0

    invoke-static {p0, p1, v0, v1, v2}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->importMpkg(Ljava/lang/String;Ljava/lang/String;JLjava/lang/String;)Ljava/lang/String;

    move-result-object p0

    return-object p0
.end method

.method public static importMpkg(Ljava/lang/String;Ljava/lang/String;JLjava/lang/String;)Ljava/lang/String;
    .locals 2

    .line 53
    if-eqz p0, :cond_3

    invoke-virtual {p0}, Ljava/lang/String;->isEmpty()Z

    move-result v0

    if-nez v0, :cond_3

    if-eqz p1, :cond_3

    invoke-virtual {p1}, Ljava/lang/String;->isEmpty()Z

    move-result v0

    if-eqz v0, :cond_0

    goto :goto_2

    .line 56
    :cond_0
    const-string v0, "native-bridge-import"

    invoke-static {v0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->baseExtras(Ljava/lang/String;)Landroid/os/Bundle;

    move-result-object v0

    .line 57
    const-string v1, "operationId"

    invoke-virtual {v0, v1, p0}, Landroid/os/Bundle;->putString(Ljava/lang/String;Ljava/lang/String;)V

    .line 58
    const-string p0, "sourceUri"

    invoke-virtual {v0, p0, p1}, Landroid/os/Bundle;->putString(Ljava/lang/String;Ljava/lang/String;)V

    .line 59
    const-string p0, "displayName"

    const-string p1, "import.mpkg"

    invoke-virtual {v0, p0, p1}, Landroid/os/Bundle;->putString(Ljava/lang/String;Ljava/lang/String;)V

    .line 60
    const-wide/16 p0, 0x0

    cmp-long p0, p2, p0

    if-lez p0, :cond_1

    goto :goto_0

    :cond_1
    const-wide/16 p2, 0x1

    :goto_0
    const-string p0, "bytes"

    invoke-virtual {v0, p0, p2, p3}, Landroid/os/Bundle;->putLong(Ljava/lang/String;J)V

    .line 61
    const-string p0, "sha256"

    if-eqz p4, :cond_2

    invoke-virtual {p4}, Ljava/lang/String;->length()I

    move-result p1

    const/16 p2, 0x40

    if-ne p1, p2, :cond_2

    .line 62
    invoke-virtual {v0, p0, p4}, Landroid/os/Bundle;->putString(Ljava/lang/String;Ljava/lang/String;)V

    goto :goto_1

    .line 64
    :cond_2
    const-string p1, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    invoke-virtual {v0, p0, p1}, Landroid/os/Bundle;->putString(Ljava/lang/String;Ljava/lang/String;)V

    .line 66
    :goto_1
    const-string p0, "import_mpkg"

    invoke-static {p0, v0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->call(Ljava/lang/String;Landroid/os/Bundle;)Ljava/lang/String;

    move-result-object p0

    return-object p0

    .line 54
    :cond_3
    :goto_2
    const-string p0, "BAD_REQUEST"

    invoke-static {p0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->failClosed(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p0

    return-object p0
.end method

.method static jsonEscape(Ljava/lang/String;)Ljava/lang/String;
    .locals 4

    .line 179
    if-nez p0, :cond_0

    const-string p0, ""

    return-object p0

    .line 180
    :cond_0
    new-instance v0, Ljava/lang/StringBuilder;

    invoke-virtual {p0}, Ljava/lang/String;->length()I

    move-result v1

    add-int/lit8 v1, v1, 0x8

    invoke-direct {v0, v1}, Ljava/lang/StringBuilder;-><init>(I)V

    .line 181
    const/4 v1, 0x0

    :goto_0
    invoke-virtual {p0}, Ljava/lang/String;->length()I

    move-result v2

    if-ge v1, v2, :cond_2

    .line 182
    invoke-virtual {p0, v1}, Ljava/lang/String;->charAt(I)C

    move-result v2

    .line 183
    sparse-switch v2, :sswitch_data_0

    .line 200
    const/16 v3, 0x20

    if-ge v2, v3, :cond_1

    .line 201
    invoke-static {v2}, Ljava/lang/Integer;->valueOf(I)Ljava/lang/Integer;

    move-result-object v2

    filled-new-array {v2}, [Ljava/lang/Object;

    move-result-object v2

    const-string v3, "\\u%04x"

    invoke-static {v3, v2}, Ljava/lang/String;->format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;

    move-result-object v2

    invoke-virtual {v0, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    goto :goto_1

    .line 185
    :sswitch_0
    const-string v2, "\\\\"

    invoke-virtual {v0, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    .line 186
    goto :goto_1

    .line 188
    :sswitch_1
    const-string v2, "\\\""

    invoke-virtual {v0, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    .line 189
    goto :goto_1

    .line 194
    :sswitch_2
    const-string v2, "\\r"

    invoke-virtual {v0, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    .line 195
    goto :goto_1

    .line 191
    :sswitch_3
    const-string v2, "\\n"

    invoke-virtual {v0, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    .line 192
    goto :goto_1

    .line 197
    :sswitch_4
    const-string v2, "\\t"

    invoke-virtual {v0, v2}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;

    .line 198
    goto :goto_1

    .line 203
    :cond_1
    invoke-virtual {v0, v2}, Ljava/lang/StringBuilder;->append(C)Ljava/lang/StringBuilder;

    .line 181
    :goto_1
    add-int/lit8 v1, v1, 0x1

    goto :goto_0

    .line 207
    :cond_2
    invoke-virtual {v0}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;

    move-result-object p0

    return-object p0

    nop

    :sswitch_data_0
    .sparse-switch
        0x9 -> :sswitch_4
        0xa -> :sswitch_3
        0xd -> :sswitch_2
        0x22 -> :sswitch_1
        0x5c -> :sswitch_0
    .end sparse-switch
.end method

.method public static ping()Ljava/lang/String;
    .locals 2

    .line 40
    const-string v0, "native-bridge-ping"

    invoke-static {v0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->baseExtras(Ljava/lang/String;)Landroid/os/Bundle;

    move-result-object v0

    .line 41
    const-string v1, "ping"

    invoke-static {v1, v0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->call(Ljava/lang/String;Landroid/os/Bundle;)Ljava/lang/String;

    move-result-object v0

    return-object v0
.end method

.method public static renewAction(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;
    .locals 1

    .line 86
    const/4 v0, 0x1

    invoke-static {p0, p1, v0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->renewAction(Ljava/lang/String;Ljava/lang/String;I)Ljava/lang/String;

    move-result-object p0

    return-object p0
.end method

.method public static renewAction(Ljava/lang/String;Ljava/lang/String;I)Ljava/lang/String;
    .locals 2

    .line 75
    if-eqz p0, :cond_1

    if-nez p1, :cond_0

    goto :goto_0

    .line 78
    :cond_0
    const-string v0, "native-bridge-renew"

    invoke-static {v0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->baseExtras(Ljava/lang/String;)Landroid/os/Bundle;

    move-result-object v0

    .line 79
    const-string v1, "operationId"

    invoke-virtual {v0, v1, p0}, Landroid/os/Bundle;->putString(Ljava/lang/String;Ljava/lang/String;)V

    .line 80
    const-string p0, "actionToken"

    invoke-virtual {v0, p0, p1}, Landroid/os/Bundle;->putString(Ljava/lang/String;Ljava/lang/String;)V

    .line 81
    const-string p0, "actionEpoch"

    invoke-virtual {v0, p0, p2}, Landroid/os/Bundle;->putInt(Ljava/lang/String;I)V

    .line 82
    const-string p0, "renew_action"

    invoke-static {p0, v0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->call(Ljava/lang/String;Landroid/os/Bundle;)Ljava/lang/String;

    move-result-object p0

    return-object p0

    .line 76
    :cond_1
    :goto_0
    const-string p0, "BAD_REQUEST"

    invoke-static {p0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->failClosed(Ljava/lang/String;)Ljava/lang/String;

    move-result-object p0

    return-object p0
.end method

.method public static status(Ljava/lang/String;)Ljava/lang/String;
    .locals 2

    .line 45
    const-string v0, "native-bridge-status"

    invoke-static {v0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->baseExtras(Ljava/lang/String;)Landroid/os/Bundle;

    move-result-object v0

    .line 46
    if-eqz p0, :cond_0

    invoke-virtual {p0}, Ljava/lang/String;->isEmpty()Z

    move-result v1

    if-nez v1, :cond_0

    .line 47
    const-string v1, "operationId"

    invoke-virtual {v0, v1, p0}, Landroid/os/Bundle;->putString(Ljava/lang/String;Ljava/lang/String;)V

    .line 49
    :cond_0
    const-string p0, "status"

    invoke-static {p0, v0}, Lcom/mineradio/app/car/WallpaperPluginProviderClient;->call(Ljava/lang/String;Landroid/os/Bundle;)Ljava/lang/String;

    move-result-object p0

    return-object p0
.end method
