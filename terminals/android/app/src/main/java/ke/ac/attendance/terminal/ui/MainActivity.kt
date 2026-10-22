package ke.ac.attendance.terminal.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import ke.ac.attendance.terminal.domain.Feedback
import ke.ac.attendance.terminal.hardware.WedgeBuffer
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val vm: TerminalViewModel by viewModels()
    private val wedge = WedgeBuffer { vm.engine.onScan(it) }
    private val tone by lazy { ToneGenerator(AudioManager.STREAM_NOTIFICATION, 90) }
    private var scannerReceiver: BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A terminal sits in someone's hand for a whole class; don't let it dim off mid-queue.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            TerminalApp(vm = vm, onCameraScan = ::scanWithCamera, onScannerSettingsChanged = ::registerScannerBroadcast)
        }
        lifecycleScope.launch {
            var last: Feedback? = null
            vm.engine.state.collect { state ->
                val feedback = state.feedback
                if (feedback != null && feedback !== last) beep(feedback)
                last = feedback
            }
        }
        registerScannerBroadcast()
    }

    override fun onDestroy() {
        scannerReceiver?.let { unregisterReceiver(it) }
        tone.release()
        super.onDestroy()
    }

    /** Hardware scanners in keyboard-wedge mode type the code and press Enter. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val fromHardware = event.deviceId != KeyCharacterMap.VIRTUAL_KEYBOARD && event.device?.isVirtual == false
        if (fromHardware && event.action == KeyEvent.ACTION_DOWN && currentFocus?.onCheckIsTextEditor() != true) {
            when {
                event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_TAB -> { wedge.onEnd(); return true }
                event.unicodeChar != 0 -> { wedge.onChar(event.unicodeChar.toChar(), event.eventTime); return true }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun scanWithCamera() {
        GmsBarcodeScanning.getClient(this).startScan()
            .addOnSuccessListener { barcode -> barcode.rawValue?.let { vm.engine.onScan(it) } }
    }

    /** Scanners set to "broadcast" mode send each read as an intent; action and extra come from the setup screen. */
    private fun registerScannerBroadcast() {
        scannerReceiver?.let { unregisterReceiver(it) }
        scannerReceiver = null
        val action = vm.broadcastAction.ifBlank { return }
        val extra = vm.broadcastExtra
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val text = intent.getStringExtra(extra) ?: intent.extras?.keySet()?.firstNotNullOfOrNull { intent.extras?.getString(it) }
                text?.let { vm.engine.onScan(it) }
            }
        }
        ContextCompat.registerReceiver(this, receiver, IntentFilter(action), ContextCompat.RECEIVER_EXPORTED)
        scannerReceiver = receiver
    }

    private fun beep(feedback: Feedback) {
        val toneType = when (feedback) {
            is Feedback.Recorded -> ToneGenerator.TONE_PROP_ACK
            is Feedback.AlreadyRecorded, is Feedback.Info -> ToneGenerator.TONE_PROP_BEEP
            is Feedback.Refused -> ToneGenerator.TONE_PROP_NACK
        }
        tone.startTone(toneType, 200)
    }
}
