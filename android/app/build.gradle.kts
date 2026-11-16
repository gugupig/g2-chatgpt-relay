plugins {
    id("com.android.application")
}

android {
    namespace = "com.g2codeterminal.relay"
    // GeckoView 159 requires compiling against 37.2; targetSdk stays at 36.
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "com.g2codeterminal.relay"
        minSdk = 26
        targetSdk = 36
        versionCode = 17
        versionName = "0.5.0"
        // The test phone (Galaxy Z Fold5) is arm64; GeckoView ships every ABI.
        ndk { abiFilters += "arm64-v8a" }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("org.mozilla.geckoview:geckoview:159.0.20261102144711")
    implementation("org.java-websocket:Java-WebSocket:1.6.0")
}
