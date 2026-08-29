plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.autodarts.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.autodarts.tv"
        minSdk = 24            // covers basically every Android TV out there
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // CI signs with the real keystore (env vars set by the workflow);
            // local release builds fall back to debug signing so they stay installable.
            signingConfig = if (System.getenv("KEYSTORE_FILE") != null) {
                signingConfigs.create("release") {
                    storeFile = file(System.getenv("KEYSTORE_FILE"))
                    storePassword = System.getenv("KEYSTORE_PASSWORD")
                    keyAlias = System.getenv("KEY_ALIAS")
                    keyPassword = System.getenv("KEY_PASSWORD")
                }
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    // TfaBridge: replaces the extension's MV3 service worker (CORS-free fetch proxy)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
