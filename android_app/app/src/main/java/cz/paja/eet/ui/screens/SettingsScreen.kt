package cz.paja.eet.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import cz.paja.eet.data.PaymentPreset
import cz.paja.eet.ui.SettingsViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(viewModel: SettingsViewModel, onBack: () -> Unit) {
    val snackbarHostState = remember { SnackbarHostState() }
    val form = viewModel.form

    LaunchedEffect(viewModel.justSaved) {
        if (viewModel.justSaved) snackbarHostState.showSnackbar("Nastavení uloženo")
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Nastavení") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zpět")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (!viewModel.loaded) {
                Text("Načítání…")
                return@Column
            }

            Text("EET 2.0", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            OutlinedTextField(
                value = form.eetUrl,
                onValueChange = { v -> viewModel.update { it.copy(eetUrl = v) } },
                label = { Text("EET_URL") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = form.eetToken,
                onValueChange = { v -> viewModel.update { it.copy(eetToken = v) } },
                label = { Text("EET_TOKEN") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )

            HorizontalDivider()

            Text("Bankovní účet", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            OutlinedTextField(
                value = form.bankAccountNumber,
                onValueChange = { v -> viewModel.update { it.copy(bankAccountNumber = v) } },
                label = { Text("Číslo účtu (např. 123-456789)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = form.bankCode,
                onValueChange = { v -> viewModel.update { it.copy(bankCode = v) } },
                label = { Text("Kód banky (např. 0800)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            HorizontalDivider()

            Text("Konstantní symboly", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            OutlinedTextField(
                value = form.ksServices,
                onValueChange = { v -> viewModel.update { it.copy(ksServices = v) } },
                label = { Text("KS pro platby za masáž") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = form.ksVouchers,
                onValueChange = { v -> viewModel.update { it.copy(ksVouchers = v) } },
                label = { Text("KS pro platby za poukázky") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            HorizontalDivider()

            Text("Přednastavené platby", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            PresetsEditor(
                presets = form.presets,
                onAdd = viewModel::addPreset,
                onUpdate = viewModel::updatePreset,
                onRemove = viewModel::removePreset,
            )

            Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                TextButton(onClick = { viewModel.save(); onBack() }) { Text("Uložit") }
            }
        }
    }
}

@Composable
private fun PresetsEditor(
    presets: List<PaymentPreset>,
    onAdd: (description: String, amountCzk: Int) -> Unit,
    onUpdate: (id: String, description: String, amountCzk: Int) -> Unit,
    onRemove: (id: String) -> Unit,
) {
    var editingId by remember { mutableStateOf<String?>(null) }
    var formDescription by remember { mutableStateOf("") }
    var formAmount by remember { mutableStateOf("") }

    fun clearForm() {
        editingId = null
        formDescription = ""
        formAmount = ""
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        presets.forEach { preset ->
            Card {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(preset.description, fontWeight = FontWeight.Bold)
                        Text("${preset.amountCzk} Kč", style = MaterialTheme.typography.bodyMedium)
                    }
                    IconButton(
                        onClick = {
                            editingId = preset.id
                            formDescription = preset.description
                            formAmount = preset.amountCzk.toString()
                        },
                    ) {
                        Icon(Icons.Filled.Edit, contentDescription = "Upravit")
                    }
                    IconButton(onClick = { onRemove(preset.id); if (editingId == preset.id) clearForm() }) {
                        Icon(Icons.Filled.Delete, contentDescription = "Smazat")
                    }
                }
            }
        }

        Text(
            if (editingId == null) "Nová platba" else "Upravit platbu",
            style = MaterialTheme.typography.labelLarge,
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = formDescription,
                onValueChange = { formDescription = it },
                label = { Text("Popis") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = formAmount,
                onValueChange = { v -> if (v.length <= 9 && (v.isEmpty() || v.toIntOrNull() != null)) formAmount = v },
                label = { Text("Kč") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (editingId != null) {
                OutlinedButton(onClick = { clearForm() }, modifier = Modifier.weight(1f)) { Text("Zrušit") }
            }
            OutlinedButton(
                onClick = {
                    val amount = formAmount.toIntOrNull()
                    if (formDescription.isNotBlank() && amount != null && amount > 0) {
                        val id = editingId
                        if (id != null) onUpdate(id, formDescription.trim(), amount) else onAdd(formDescription.trim(), amount)
                        clearForm()
                    }
                },
                modifier = Modifier.weight(1f),
            ) { Text(if (editingId == null) "Přidat platbu" else "Uložit změny") }
        }
    }
}
