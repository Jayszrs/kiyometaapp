import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

// Dev server URL — the Vite dev server (`cd webapp && npm run dev`) with
// `host: true` set in vite.config.ts, printed as "Network:" in its terminal
// output. Update this if the PC's LAN IP or the dev server port changes.
const String kServerUrl = 'http://192.168.1.2:5173';

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
      theme: ThemeData(colorSchemeSeed: const Color(0xFF1A3458), useMaterial3: true),
      home: const WebViewHome(),
    );
  }
}

class WebViewHome extends StatefulWidget {
  const WebViewHome({super.key});

  @override
  State<WebViewHome> createState() => _WebViewHomeState();
}

class _WebViewHomeState extends State<WebViewHome> {
  late final WebViewController _controller;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) => setState(() { _loading = true; _error = null; }),
          onPageFinished: (_) => setState(() => _loading = false),
          onWebResourceError: (error) => setState(() {
            _loading = false;
            _error = 'Failed to load $kServerUrl\n(${error.description})\n\n'
                'Make sure the dev server is running (cd webapp && npm run dev) '
                'and the tablet is on the same Wi-Fi network as the PC.';
          }),
        ),
      )
      ..loadRequest(Uri.parse(kServerUrl));
  }

  Future<void> _reload() async {
    setState(() { _loading = true; _error = null; });
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
                      const Icon(Icons.wifi_off, size: 40, color: Colors.grey),
                      const SizedBox(height: 12),
                      Text(_error!, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      FilledButton(onPressed: _reload, child: const Text('Retry')),
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
