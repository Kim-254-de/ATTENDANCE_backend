package ke.ac.attendance.terminal.hardware

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import ke.ac.attendance.terminal.BuildConfig
import ke.ac.attendance.terminal.data.HeartbeatReport

/** What the heartbeat reports, for the department's devices page. */
fun deviceReport(context: Context): HeartbeatReport {
    val battery = (context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager)
        .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        .takeIf { it in 0..100 }
    val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
    val network = when {
        caps == null -> null
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "CELLULAR"
        else -> null
    }
    return HeartbeatReport(batteryPercent = battery, network = network, appVersion = BuildConfig.VERSION_NAME)
}
