// Lobium Island — built-in isolation system app. Built with the Android SDK/toolchain (needs a host
// with the SDK + build-tools; not compilable on the GPU-less dev box). Output APK is placed as a
// privileged system app in the golden image (see ../image/build-golden-image.sh).
plugins {
    id("com.android.application") version "8.5.0"
    kotlin("android") version "2.0.0"
}

android {
    namespace = "com.lobium.island"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.lobium.island"
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    // Signed with the platform key at image-assembly time so it can be a privileged system app.
    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Uses only framework APIs (DevicePolicyManager, org.json) — no external deps.
}
