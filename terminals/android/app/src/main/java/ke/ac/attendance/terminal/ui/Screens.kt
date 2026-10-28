package ke.ac.attendance.terminal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ke.ac.attendance.terminal.domain.Feedback
import ke.ac.attendance.terminal.domain.UiState
import ke.ac.attendance.terminal.hardware.SimulatedFingerprintReader
import kotlinx.coroutines.launch

private val Navy = Color(0xFF12305F)
private val Green = Color(0xFF15803D)
private val Red = Color(0xFFB91C1C)
private val Amber = Color(0xFFB45309)

@Composable
fun TerminalApp(vm: TerminalViewModel, onCameraScan: () -> Unit, onScannerSettingsChanged: () -> Unit) {
    val state by vm.engine.state.collectAsStateWithLifecycle()
    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFFF6F8FB)) {
            Column(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Header(state)
                if (!state.paired) {
                    PairingScreen(vm, state, onCameraScan, onScannerSettingsChanged)
                } else {
                    state.task?.let { TaskPanel(it, vm.reader as? SimulatedFingerprintReader) }
                    if (state.task == null) ClassScreen(vm, state, onCameraScan)
                }
            }
        }
    }
}

@Composable
private fun Header(state: UiState) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text("Attendance Terminal", fontSize = 13.sp, color = Color.Gray)
            Text(state.terminal?.code ?: if (state.paired) "Paired" else "Not paired", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = Navy)
        }
        val (dot, label) = if (state.online) Green to "Online" else Red to "Offline"
        Box(Modifier.size(10.dp).background(dot, CircleShape))
        Text(" $label", fontSize = 13.sp, color = dot)
    }
}

@Composable
private fun PairingScreen(vm: TerminalViewModel, state: UiState, onCameraScan: () -> Unit, onScannerSettingsChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var url by rememberSaveable { mutableStateOf(vm.store.baseUrl) }
    var code by rememberSaveable { mutableStateOf("") }
    var action by rememberSaveable { mutableStateOf(vm.broadcastAction) }
    var extra by rememberSaveable { mutableStateOf(vm.broadcastExtra) }

    Text("Pair this terminal", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
    Text("On the department's Terminals page, add this device, then scan its pairing code here or type it in.")
    state.feedback?.let { FeedbackPanel(it) }
    OutlinedTextField(
        value = code,
        onValueChange = { code = it },
        label = { Text("Pairing code") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
        modifier = Modifier.fillMaxWidth(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Button(onClick = { vm.store.baseUrl = url; scope.launch { vm.engine.handleScan(code) } }, enabled = code.isNotBlank()) { Text("Pair") }
        OutlinedButton(onClick = { vm.store.baseUrl = url; onCameraScan() }) { Text("Scan with camera") }
    }

    Spacer(Modifier.height(8.dp))
    Text("Setup", fontWeight = FontWeight.SemiBold)
    OutlinedTextField(
        value = url,
        onValueChange = { url = it },
        label = { Text("Server address") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        modifier = Modifier.fillMaxWidth(),
    )
    Text("Built-in scanner in broadcast mode (leave empty for keyboard mode):", fontSize = 13.sp, color = Color.Gray)
    OutlinedTextField(value = action, onValueChange = { action = it }, label = { Text("Broadcast action") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(value = extra, onValueChange = { extra = it }, label = { Text("Data extra name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    TextButton(onClick = {
        vm.store.baseUrl = url
        vm.broadcastAction = action
        vm.broadcastExtra = extra
        onScannerSettingsChanged()
    }) { Text("Save setup") }
}

@Composable
private fun ClassScreen(vm: TerminalViewModel, state: UiState, onCameraScan: () -> Unit) {
    val scope = rememberCoroutineScope()
    val session = state.session
    if (session == null) {
        Card {
            Text("Not linked to a class", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            Text("Ask the lecturer to tap \"Link a terminal\" on their class screen, then scan the code.")
        }
    } else {
        Card {
            Text(session.unitCode, fontSize = 13.sp, color = Color.Gray)
            Text(session.unitName ?: "Class", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "Accepting: " + session.accepts.joinToString { if (it == "FINGERPRINT") "fingerprint" else "ID card" }.ifEmpty { "nothing on this device" },
                color = Navy,
            )
        }
    }

    state.feedback?.let { FeedbackPanel(it) } ?: Text(
        if (session == null) "" else "Scan a student ID card or place a finger on the reader.",
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
    )

    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(onClick = onCameraScan) { Text("Scan with camera") }
        if (session != null) TextButton(onClick = { scope.launch { vm.engine.unlink() } }) { Text("Unlink class") }
    }

    if (session != null) {
        var typed by remember { mutableStateOf("") }
        OutlinedTextField(
            value = typed,
            onValueChange = { typed = it },
            label = { Text("Registration number (if the card won't scan)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
            modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = { val t = typed; typed = ""; scope.launch { vm.engine.handleScan(t) } }, enabled = typed.isNotBlank()) { Text("Check in") }

        (vm.reader as? SimulatedFingerprintReader)?.let { sim ->
            if ("FINGERPRINT" in session.accepts) {
                var slot by remember { mutableStateOf("") }
                Text("Simulated fingerprint reader", fontWeight = FontWeight.SemiBold, color = Amber)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(value = slot, onValueChange = { slot = it }, label = { Text("Slot") }, singleLine = true, modifier = Modifier.weight(1f))
                    Button(onClick = { sim.press(slot) }, enabled = slot.isNotBlank()) { Text("Press finger") }
                }
            }
        }
    }
}

@Composable
private fun TaskPanel(task: String, simulated: SimulatedFingerprintReader?) {
    Card(background = Color(0xFFFFF7ED)) {
        Text("Department request", fontSize = 13.sp, color = Amber)
        Text(task, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        if (simulated != null) Button(onClick = { simulated.press("enrol") }) { Text("Enrol finger (simulated)") }
    }
}

@Composable
private fun FeedbackPanel(feedback: Feedback) {
    val (color, title, detail) = when (feedback) {
        is Feedback.Recorded -> Triple(Green, "Recorded", listOfNotNull(feedback.name, feedback.registrationNumber).joinToString("\n").ifEmpty { "Checked in by ${feedback.via}" })
        is Feedback.AlreadyRecorded -> Triple(Navy, "Already recorded", feedback.message)
        is Feedback.Refused -> Triple(Red, "Not recorded", feedback.message)
        is Feedback.Info -> Triple(Navy, "", feedback.message)
    }
    Column(
        modifier = Modifier.fillMaxWidth().background(color, RoundedCornerShape(20.dp)).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (title.isNotEmpty()) Text(title, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Text(detail, color = Color.White, fontSize = 18.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun Card(background: Color = Color.White, content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().background(background, RoundedCornerShape(16.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) { content() }
}
