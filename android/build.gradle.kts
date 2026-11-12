plugins {
    id("com.android.application") version "9.5.1" apply false
    // AGP's built-in Kotlin defaults to 2.2, which cannot read the 2.4
    // kotlin-stdlib that GeckoView 159 brings in; this selects a newer compiler.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
}

// scripts/android.sh sets G2_BUILD_ROOT so build output lands on external
// storage instead of android/**/build.
providers.environmentVariable("G2_BUILD_ROOT").orNull?.let { root ->
    allprojects {
        layout.buildDirectory.set(file("$root/${if (this == rootProject) "root" else name}"))
    }
}
