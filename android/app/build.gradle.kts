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
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    packaging {
        resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES")
    }
}

dependencies {
    implementation("com.hierynomus:sshj:0.41.1")
    implementation("org.bouncycastle:bcprov-jdk18on:1.84")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
