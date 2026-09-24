plugins {
    id("com.android.application")
}

android {
    namespace = "sh.ledge.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "sh.ledge.android"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.0.0"
    }

    // The view, built by `vite build --config vite.android.config.ts` and
    // served from the APK's assets by WebViewAssetLoader (WebHost.kt).
    sourceSets.getByName("main").assets.srcDir("$rootDir/../dist-android")

    packaging {
        resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES")
    }
}

dependencies {
    implementation("androidx.activity:activity:1.10.1")
    implementation("androidx.core:core:1.15.0")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("com.hierynomus:sshj:0.41.1")
    implementation("org.bouncycastle:bcprov-jdk18on:1.84")
}
