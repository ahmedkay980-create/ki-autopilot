plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val runNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "de.achmo.kiautopilot"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.achmo.kiautopilot"
        minSdk = 26
        targetSdk = 35
        versionCode = runNumber
        versionName = "1.0.$runNumber"
    }

    signingConfigs {
        create("release") {
            fun env(name: String, def: String) = System.getenv(name)?.takeIf { it.isNotEmpty() } ?: def
            storeFile = file(env("KEYSTORE_FILE", "../keystore/release.jks"))
            storePassword = env("KEYSTORE_PASSWORD", "kiautopilot")
            keyAlias = env("KEY_ALIAS", "kiautopilot")
            keyPassword = env("KEY_PASSWORD", "kiautopilot")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
