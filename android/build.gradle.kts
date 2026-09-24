plugins {
    id("com.android.application") version "9.4.1" apply false
    // The Compose compiler ships with Kotlin, so its version is the Kotlin
    // version AGP builds with.
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10" apply false
}
