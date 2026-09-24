# Kiyometa App

Flutter application for Kiyometa.

## Run on the project tablet

The repository includes a setup script for a shared Android tablet profile named
`Kiyometa_Tablet` (Pixel Tablet, Android API 34). The Android SDK and emulator
remain local to each developer and are not committed to Git.

On Windows, run this once after cloning to create and start the tablet:

```powershell
.\start-tablet.cmd
```

When the project is opened in VS Code, the repository also starts this task
automatically. On the first clone, choose **Allow Automatic Tasks in Folder** if
VS Code asks for confirmation.

After the tablet finishes booting, the normal command lists four connected
targets (Android tablet, Windows, Chrome, and Edge):

```powershell
flutter run
```

Inside the VS Code integrated terminal, this repository keeps the familiar
desktop/web order and adds the project tablet as option **4**. Enter `4` to
create/start the tablet when needed and run the app on it. The repository-local
wrapper only customizes the argument-free `flutter run`; all other Flutter
commands are passed through unchanged.

To skip the selection menu, use:

```powershell
.\run-tablet.cmd
```

This command creates the tablet when needed, starts it, waits until it is
detected, and runs the app directly on that tablet. In VS Code, the same actions
are available from **Terminal > Run Task**.

Requirements: Flutter, Android Studio, Android SDK Command-line Tools, Android
Emulator, and hardware virtualization. If Android licenses have not been
accepted, run `flutter doctor --android-licenses` first.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.
