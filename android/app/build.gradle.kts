plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "sh.ledge.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "sh.ledge.android"
        minSdk = 29
        // Play refuses a new app or an update that targets less than a year's
        // Android: 36 since 2026-08-31.
        targetSdk = 36
        // package.json's version and the commit count, passed by
        // scripts/android-build.ts. Play refuses a second upload with the
        // same versionCode.
        versionCode = (findProperty("ledgeBuild") as String?)?.toInt() ?: 1
        versionName = findProperty("ledgeVersion") as String? ?: "0.0.0"
    }

    // The upload key, not the key phones check: Play App Signing re-signs
    // with a key Google holds. The keystore lives outside the checkout and its
    // password comes from the Keychain, by way of the environment
    // (android.md §8). Without them the release build is unsigned, which is
    // what CI builds.
    val keystore = System.getenv("LEDGE_ANDROID_KEYSTORE")
    val password = System.getenv("LEDGE_ANDROID_KEYSTORE_PASSWORD")
    val upload = if (keystore != null && password != null) {
        signingConfigs.create("upload") {
            storeFile = file(keystore)
            storePassword = password
            keyAlias = "upload"
            keyPassword = password
        }
    } else {
        null
    }

    buildTypes {
        getByName("release") {
            signingConfig = upload
            // No R8: sshj and Bouncy Castle find their algorithms by
            // reflection, and a missed keep rule is a handshake that fails on
            // a phone and nowhere else.
            isMinifyEnabled = false
        }
    }

    // The view, built by `vite build --config vite.android.config.ts` and
    // served from the APK's assets by WebViewAssetLoader (WebHost.kt).
    sourceSets.getByName("main").assets.srcDir("$rootDir/../dist-android")

    buildFeatures.compose = true

    // The pairing-code test reads the vectors shared/pairing.ts answers to.
    testOptions.unitTests.all { it.systemProperty("ledge.repo", "$rootDir/..") }

    packaging {
        resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES")
    }
}

dependencies {
    implementation("androidx.activity:activity:1.10.1")
    // The shell's own screens: welcome, the server list, pairing, setup, and
    // the camera (ServerScreens.kt).
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.camera:camera-camera2:1.6.2")
    implementation("androidx.camera:camera-lifecycle:1.6.2")
    implementation("androidx.camera:camera-view:1.6.2")
    // QR decoding with no Google Play services, which not every phone has.
    implementation("com.google.zxing:core:3.5.4")
    implementation("androidx.core:core:1.15.0")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("com.hierynomus:sshj:0.41.1")
    implementation("org.bouncycastle:bcprov-jdk18on:1.84")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}
