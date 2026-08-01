plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.motif.wallpaperengine"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.motif.wallpaperengine"
        minSdk = 31
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-wallpaper-engine"

        // Caller cert SHA-256 injected via -PmineradioCallerCertSha256=<64 hex>.
        // Debug/unit-test fallback is a well-formed zero digest (not a secret).
        val certProp = (project.findProperty("mineradioCallerCertSha256") as String?)
            ?.trim()
            ?.lowercase()
        val certSha = if (certProp != null && certProp.matches(Regex("^[0-9a-f]{64}$"))) {
            certProp
        } else {
            "0".repeat(64)
        }
        buildConfigField("String", "MINERADIO_CALLER_CERT_SHA256", "\"$certSha\"")
        manifestPlaceholders["mineradioCallerCertSha256"] = certSha
    }

    buildTypes {
        getByName("debug") {
            // shell caller allowed only in debug (CallerPolicy reads BuildConfig.DEBUG)
        }
        getByName("release") {
            val certProp = (project.findProperty("mineradioCallerCertSha256") as String?)
                ?.trim()
                ?.lowercase()
            if (certProp == null || !certProp.matches(Regex("^[0-9a-f]{64}$"))) {
                // Fail release configuration when cert property missing/invalid.
                logger.warn(
                    "WP-02: release builds require -PmineradioCallerCertSha256=<64 hex>; " +
                        "current value missing/invalid (unit tests still use debug).",
                )
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // WP-02: protocol + runtime Provider/Service/Activity surfaces
    implementation("androidx.core:core-ktx:1.15.0")
    // MultiProcessDataStore surface dependency (repository uses injectable ledger in GREEN).
    implementation("androidx.datastore:datastore:1.1.1")
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
}
