package com.example.kiyometaapp

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintManager
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    private val channelName = "com.example.kiyometaapp/bridge"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "saveFile" -> {
                        val name = call.argument<String>("fileName") ?: "kiyometa-download"
                        val mime = call.argument<String>("mimeType") ?: "application/octet-stream"
                        val bytes = call.argument<ByteArray>("bytes")
                        if (bytes == null) {
                            result.error("bad_args", "Missing file bytes", null)
                        } else {
                            try {
                                result.success(saveToDownloads(name, mime, bytes))
                            } catch (error: Exception) {
                                result.error("save_failed", error.message, null)
                            }
                        }
                    }

                    "print" -> {
                        val html = call.argument<String>("html")
                        val jobName = call.argument<String>("jobName") ?: "Kiyometa"
                        val baseUrl = call.argument<String>("baseUrl")
                        if (html == null) {
                            result.error("bad_args", "Missing html", null)
                        } else {
                            printHtml(html, jobName, baseUrl)
                            result.success(null)
                        }
                    }

                    else -> result.notImplemented()
                }
            }
    }

    // Writes the file into the shared Downloads collection (visible in the Files
    // app) using MediaStore on Android 10+, so no storage permission is needed.
    // Older devices fall back to the app-specific external directory.
    private fun saveToDownloads(name: String, mime: String, bytes: ByteArray): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = applicationContext.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("Could not create a Downloads entry")
            try {
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: throw IllegalStateException("Could not open the Downloads stream")
            } finally {
                val done = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                resolver.update(uri, done, null, null)
            }
            return "Download/$name"
        }

        val dir = getExternalFilesDir("Download")
            ?: File(filesDir, "Download")
        if (!dir.exists()) dir.mkdirs()
        val file = File(dir, name)
        file.writeBytes(bytes)
        return file.absolutePath
    }

    // Android WebView cannot handle window.print(); render the page the web app
    // hands us in an offscreen WebView and hand it to the Android print service,
    // which offers both physical printers and "Save as PDF".
    private fun printHtml(html: String, jobName: String, baseUrl: String?) {
        runOnUiThread {
            val webView = WebView(this)
            webView.settings.javaScriptEnabled = false
            addContentView(
                webView,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
            webView.visibility = View.INVISIBLE

            webView.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    val printManager = getSystemService(Context.PRINT_SERVICE) as PrintManager
                    val delegate = view.createPrintDocumentAdapter(jobName)
                    val adapter = object : PrintDocumentAdapter() {
                        override fun onStart() = delegate.onStart()

                        override fun onLayout(
                            old: PrintAttributes?,
                            new: PrintAttributes?,
                            cancel: CancellationSignal?,
                            callback: LayoutResultCallback?,
                            extras: Bundle?,
                        ) = delegate.onLayout(old, new, cancel, callback, extras)

                        override fun onWrite(
                            pages: Array<out PageRange>?,
                            destination: ParcelFileDescriptor?,
                            cancel: CancellationSignal?,
                            callback: WriteResultCallback?,
                        ) = delegate.onWrite(pages, destination, cancel, callback)

                        override fun onFinish() {
                            delegate.onFinish()
                            (view.parent as? ViewGroup)?.removeView(view)
                        }
                    }

                    printManager.print(jobName, adapter, PrintAttributes.Builder().build())
                }
            }

            val resolvedBase = if (baseUrl.isNullOrBlank()) "about:blank" else baseUrl
            webView.loadDataWithBaseURL(resolvedBase, html, "text/html", "utf-8", null)
        }
    }
}
