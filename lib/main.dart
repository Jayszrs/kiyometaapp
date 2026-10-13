import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

// The tablet runner maps this emulator-local port to the Vite server on the
// development PC with `adb reverse`, so this URL does not depend on Wi-Fi IPs.
// Build a production APK with:
//   flutter build apk --release --dart-define=APP_URL=https://...your-host.../
const String kServerUrl =
    String.fromEnvironment('APP_URL', defaultValue: 'http://127.0.0.1:5173');

// Native capabilities the embedded web app calls through the KiyometaAndroid
// JavaScript channel: saving exports (CSV/Excel) and printing documents.
const MethodChannel _bridge = MethodChannel('com.example.kiyometaapp/bridge');
final GlobalKey<ScaffoldMessengerState> _messengerKey =
    GlobalKey<ScaffoldMessengerState>();

void main() {
  runApp(const KiyometaApp());
}

class KiyometaApp extends StatelessWidget {
  const KiyometaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Kiyometa Order Management',
      debugShowCheckedModeBanner: false,
      scaffoldMessengerKey: _messengerKey,
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF1A3458),
        useMaterial3: true,
      ),
      home: const WebViewHome(),
    );
  }
}

class WebViewHome extends StatefulWidget {
  const WebViewHome({super.key});

  @override
  State<WebViewHome> createState() => _WebViewHomeState();
}

class _WebViewHomeState extends State<WebViewHome> with WidgetsBindingObserver {
  late final WebViewController _controller;
  bool _loading = true;
  String? _error;
  bool _pageLoaded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) => setState(() {
            _loading = true;
            _error = null;
            _pageLoaded = false;
          }),
          onPageFinished: (_) => setState(() {
            _loading = false;
            _pageLoaded = true;
          }),
          onWebResourceError: (error) => setState(() {
            _loading = false;
            _error =
                'Failed to load $kServerUrl\n(${error.description})\n\n'
                'Run the app through option 4 so the project runner can start '
                'the web server and connect it to the Android emulator.';
          }),
        ),
      );

    // Android WebView has no built-in <input type="file"> handler. Without this
    // the "Upload document" and "Take photo" buttons in the quotation scan do
    // nothing. Other platforms (web/Windows) let the host browser handle it.
    final platform = controller.platform;
    if (!kIsWeb && platform is AndroidWebViewController) {
      // File inputs are opened from a file:// URI for the camera. WebView blocks
      // file:// access by default when targeting API 30+.
      platform.setAllowFileAccess(true);
      platform.setAllowContentAccess(true);
      platform.setOnShowFileSelector(_handleFileSelector);
    }

    // The KiyometaAndroid channel is the native bridge the embedded web app
    // calls to save exports (CSV/Excel) and print documents.
    controller.addJavaScriptChannel(
      'KiyometaAndroid',
      onMessageReceived: _onBridgeMessage,
    );

    controller.loadRequest(Uri.parse(kServerUrl));
    _controller = controller;
  }

  Future<void> _onBridgeMessage(JavaScriptMessage message) async {
    Map<String, dynamic> data;
    try {
      data = jsonDecode(message.message) as Map<String, dynamic>;
    } catch (_) {
      return;
    }

    final action = data['action'];
    try {
      switch (action) {
        case 'download':
          final fileName = data['fileName'] as String? ?? 'kiyometa-download';
          final mimeType =
              data['mimeType'] as String? ?? 'application/octet-stream';
          final encoded = data['base64'] as String? ?? '';
          final location = await _bridge.invokeMethod<String>('saveFile', {
            'fileName': fileName,
            'mimeType': mimeType,
            'bytes': base64Decode(encoded),
          });
          _showMessage('Saved to ${location ?? fileName}');
          break;
        case 'print':
          await _bridge.invokeMethod<void>('print', {
            'html': data['html'] as String? ?? '',
            'jobName': data['jobName'] as String? ?? 'Kiyometa',
            'baseUrl': data['baseUrl'] as String?,
          });
          _showMessage('Opening the print dialog…');
          break;
        default:
          break;
      }
    } catch (error) {
      _showMessage('Action failed: $error');
    }
  }

  void _showMessage(String text) {
    _messengerKey.currentState?.showSnackBar(SnackBar(content: Text(text)));
  }

  Future<List<String>> _handleFileSelector(FileSelectorParams params) async {
    try {
      final sources = <String>[];
      if (params.isCaptureEnabled) {
        final XFile? shot = await ImagePicker().pickImage(
          source: ImageSource.camera,
          imageQuality: 90,
        );
        if (shot != null) sources.add(shot.path);
      } else {
        final extensions = _extensionsFor(params.acceptTypes);
        if (params.mode == FileSelectorMode.openMultiple) {
          final files = await FilePicker.pickFiles(
            type: extensions == null ? FileType.any : FileType.custom,
            allowedExtensions: extensions,
          );
          sources.addAll(files.map((file) => file.path).whereType<String>());
        } else {
          final file = await FilePicker.pickFile(
            type: extensions == null ? FileType.any : FileType.custom,
            allowedExtensions: extensions,
          );
          if (file?.path != null) sources.add(file!.path!);
        }
      }

      final readable = await Future.wait(sources.map(_webviewReadablePath));
      return readable.map((path) => Uri.file(path).toString()).toList();
    } catch (_) {
      return const <String>[];
    }
  }

  static const List<List<int>> _heifBrands = [
    [0x68, 0x65, 0x69, 0x63], // heic
    [0x68, 0x65, 0x69, 0x78], // heix
    [0x68, 0x65, 0x76, 0x63], // hevc
    [0x68, 0x65, 0x76, 0x78], // hevx
    [0x6d, 0x69, 0x66, 0x31], // mif1
    [0x6d, 0x73, 0x66, 0x31], // msf1
  ];

  static bool _bytesEqual(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  static bool _isHeifContainer(Uint8List bytes) {
    if (bytes.length < 12) return false;
    // ISO BMFF: 4-byte size, then 'ftyp' at offset 4.
    if (bytes[4] != 0x66 || bytes[5] != 0x74 || bytes[6] != 0x79 || bytes[7] != 0x70) {
      return false;
    }
    final brand = bytes.sublist(8, 12);
    return _heifBrands.any((b) => _bytesEqual(b, brand));
  }

  // Camera photos (up to ~12 MP) crash the WebView renderer under the memory
  // pressure of this low-RAM tablet, which wipes the editor state and reloads
  // the page. Galaxy cameras also save HEIC by default, which Chromium's
  // WebView cannot decode. Decode through the platform codec, downscaling to a
  // dimension the editor can handle, and re-wrap as PNG before handing the path
  // to the WebView. Files that are not oversized or unreadable pass through.
  static const int _maxImageDimension = 1600;

  Future<String> _webviewReadablePath(String sourcePath) async {
    try {
      final bytes = await File(sourcePath).readAsBytes();
      final isHeif = _isHeifContainer(bytes);

      final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
      final ui.ImageDescriptor descriptor;
      try {
        descriptor = await ui.ImageDescriptor.encoded(buffer);
      } catch (_) {
        buffer.dispose();
        return sourcePath; // Not a decodable image (e.g. PDF) - pass through.
      }
      final width = descriptor.width;
      final height = descriptor.height;
      final longest = math.max(width, height);
      final needsDownscale = longest > _maxImageDimension;
      if (!isHeif && !needsDownscale) {
        descriptor.dispose();
        buffer.dispose();
        return sourcePath;
      }
      final scale =
          needsDownscale ? _maxImageDimension / longest : 1.0;
      descriptor.dispose();
      buffer.dispose();

      final codec = await ui.instantiateImageCodec(
        bytes,
        targetWidth: (width * scale).round(),
        targetHeight: (height * scale).round(),
      );
      final frame = await codec.getNextFrame();
      final data = await frame.image.toByteData(format: ui.ImageByteFormat.png);
      frame.image.dispose();
      if (data == null) return sourcePath;
      final target = File('$sourcePath.decoded.png');
      await target.writeAsBytes(
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
      return target.path;
    } catch (_) {
      return sourcePath;
    }
  }

  List<String>? _extensionsFor(List<String> acceptTypes) {
    if (acceptTypes.isEmpty || acceptTypes.contains('*/*')) {
      return null;
    }

    final extensions = <String>{};
    for (final type in acceptTypes) {
      final value = type.toLowerCase();
      if (value == 'application/pdf' || value == '.pdf') {
        extensions.add('pdf');
      } else if (value.startsWith('image/')) {
        extensions.addAll(const ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic']);
      } else if (value == 'application/msword') {
        extensions.add('doc');
      } else if (value ==
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        extensions.add('docx');
      }
    }

    return extensions.isEmpty ? null : extensions.toList();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // While the app is backgrounded the WebView is frozen, so the web app's own
  // focus/visibility listeners never fire and it can keep showing stale data
  // until the next poll. Push a resume event (matching the "kiyometa-resume"
  // listener in App.tsx) so the web app refetches on return to foreground.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed || !_pageLoaded) return;
    try {
      _controller.runJavaScript("window.dispatchEvent(new Event('kiyometa-resume'))");
    } catch (_) {
      // WebView not ready for scripting; the poll and visibility listeners cover it.
    }
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    await _controller.reload();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            if (_error == null) WebViewWidget(controller: _controller),
            if (_loading && _error == null)
              const Center(child: CircularProgressIndicator()),
            if (_error != null)
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(12),
                        child: Image.asset(
                          'assets/branding/kiyometa-logo.png',
                          width: 72,
                          height: 72,
                          fit: BoxFit.cover,
                        ),
                      ),
                      const SizedBox(height: 12),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 520),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed: _reload,
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
