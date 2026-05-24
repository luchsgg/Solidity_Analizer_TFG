const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { exec } = require('child_process');

const {
    executeSolcGas,
    analyzeContract,
    runCFG,
    runSaco,
    runGastap,
    runCTranslation,
    runHashes,
    runMemAnalysis,
    runStorageAnalysis,
    runWithSolc,
    runVerify,
    runEthirCombo,
    parseGastapOutput,
} = require('./calculos');

const {
    highlightFunctionHeadersByCost,
    highlightFunctionHeaders,
    clearDecorations,
} = require('./decoración');


// Envuelve exec en una Promise ---------------------
function execAsync(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve({ stdout, stderr });
        });
    });
}

class SidebarProvider {

    constructor(context) {
        this._context          = context;
        this._view             = undefined;
        this._currentFunctions = [];
        this._decorations      = [];   // decoraciones activas, una por instancia
        this._lastSolFile      = undefined;
        this._ethirChannel     = vscode.window.createOutputChannel('EthIR');
    }

    // Registro del Webview: -----------------------------------
    resolveWebviewView(webviewView) {
        this._view = webviewView;

        webviewView.onDidDispose(() => { this._view = undefined; });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };

        webviewView.webview.html = this._getHtmlContent(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case 'highlightYellow':   await this._highlightYellow();                        break;
                    case 'analyzeSolc':       await this._analyzeSolc();                            break;
                    case 'clearHighlights':        this._clearHighlights();                         break;
                    case 'highlightFunction':      this._highlightSingleFunction(message.functionName); break;
                    case 'addSolFile':             this._addSolFile();                              break;
                    case 'openDotGraph':           this.openDotGraph();                             break;
                    case 'cfg':               await this._runCFG();                                 break;
                    case 'saco':              await this._runSaco();                                break;
                    case 'cfile':             await this._runC();                                   break;
                    case 'safevm':            await this._runSafevm();                              break;
                    case 'hashes':            await this._runHashes();                              break;
                    case 'memAnalysis':       await this._runMemAnalysis();                         break;
                    case 'storageAnalysis':   await this._runStorageAnalysis();                     break;
                    case 'solcCompiler':      await this._runSolcCompiler();                        break;
                    case 'ethirCombo':        await this._runEthirCombo(message.flags);             break;
                    case 'openDotCostabs':    await this._openDotFromCostabs();                     break;
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Error: ${err.message}`);
            }
        });

        this._context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor && editor.document.fileName.endsWith('.sol')) {
                    this._lastSolFile = editor.document.fileName;
                }
                this._updateFunctionList();
            })
        );
    }

    // funciones de decoración: -----------------------------------

    async _highlightYellow() {
        const editor = this._requireSolEditor();
        if (!editor) return;

        const results = analyzeContract(editor.document.fileName);
        highlightFunctionHeaders(editor, results, this._decorations);
        this._currentFunctions = results;
        this._updateFunctionList();
        vscode.window.showInformationMessage(`${results.length} funciones resaltadas`);
    }

    async _analyzeSolc() {
        const editor = this._requireSolEditor();
        if (!editor) return;

        if (editor.document.isDirty) await editor.document.save();

        const funciones = await this._runWithProgress(
            'Analizando con solc...',
            () => executeSolcGas(editor.document.fileName)
        );

        highlightFunctionHeadersByCost(editor, funciones, this._decorations);
        this._currentFunctions = funciones;
        this._postMessage({ command: 'updateFunctions', functions: funciones });
        vscode.window.showInformationMessage(`${funciones.length} funciones analizadas`);
    }

    _clearHighlights() {
        clearDecorations(this._decorations);
        this._currentFunctions = [];
        this._updateFunctionList();
        vscode.window.showInformationMessage('Resaltados limpiados');
    }

    _highlightSingleFunction(name) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const func = this._currentFunctions.find(f => f.name === name);
        if (func) {
            const line  = func.line - 1;
            const range = new vscode.Range(line, 0, line, 0);
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
    }

    _updateFunctionList() {
        this._postMessage({ command: 'updateFunctions', functions: this._currentFunctions });
    }

    _addSolFile() {
        vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Abrir archivo .sol',
            filters: { 'Solidity': ['sol'] },
        }).then(async fileUri => {
            if (!fileUri || !fileUri[0]) return;
            const filePath = fileUri[0].fsPath;
            // Primero abrimos el documento y lo mostramos, luego analizamos
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
            this._currentFunctions = analyzeContract(filePath);
            this._updateFunctionList();
        });
    }
   
    // Helper: extrae el directorio costabs del output de EthIR -----------------------------------
    _extractCostabsDir(ethirOutput) {
        if (!ethirOutput) return null;
        const match = ethirOutput.match(/stored in the following directory:\s*(\/tmp\/ethir_\S+)/);
        return match ? match[1].replace(/\/$/, '') : null;
    }

    // Helper: copia los archivos a un directorio fijo antes de que desaparezcan
    async _copyEthirFiles(ethirOutput) {
        const sourceDir = this._extractCostabsDir(ethirOutput);
        if (!sourceDir) {
            console.log('[copyEthirFiles] No se encontró sourceDir en el output');
            return null;
        }

        const destDirWin = path.join(os.homedir(), 'ethir_output_plugin');
        console.log('[copyEthirFiles] destDirWin:', destDirWin);

        try {
            const { stdout: wslDest } = await execAsync(
                `wsl wslpath "${destDirWin.replace(/\\/g, '\\\\')}"`
            );
            const destDirWSL = wslDest.trim();
            console.log('[copyEthirFiles] destDirWSL:', destDirWSL);

            const { stdout } = await execAsync(
                `wsl bash -c "mkdir -p '${destDirWSL}' && cp -r '${sourceDir}/.' '${destDirWSL}/' && echo OK"`
            );
            console.log('[copyEthirFiles] resultado cp:', stdout);
            return destDirWin;
        } catch (e) {
            console.log('[copyEthirFiles] ERROR:', e.message);
            vscode.window.showWarningMessage(`No se pudieron copiar los archivos: ${e.message}`);
            return null;
        }
    }

    _filterEthirOutput(output, flags = []) {
        const lines = output.split('\n');
        const result = [];
        let inStars = false;
        let gastapFound = false;

        const hasCFG    = flags.some(f => f.startsWith('-cfg'));

        for (const line of lines) {
            const trimmed = line.trim();

            // Bloque entre asteriscos
            if (trimmed.startsWith('*****')) {
                inStars = !inStars;
                result.push(line);
                continue;
            }
            if (inStars) {
                result.push(line);
                continue;
            }

            // Líneas relevantes fuera del bloque (antes de GASTAPRES)
            if (trimmed.startsWith('File:'))      result.push(line);
            if (trimmed.startsWith('GAS for'))    result.push(line);
            if (trimmed.startsWith('BLOCKS for')) result.push(line);
            if (trimmed.startsWith('Build RBR:')) result.push(line);
            if (trimmed.startsWith('SACO RBR:'))  result.push(line);

            // A partir de GASTAPRES: mostrar todo
            if (trimmed.startsWith('GASTAPRES:')) gastapFound = true;
            if (gastapFound) {
                result.push(line);
                continue;
            }

            if (hasCFG && trimmed.startsWith('Build CFG:')) result.push(line);
        }

        return result.join('\n').trim();
    }

    // -- Helper: renderiza un panel webview con contenido .dot -----------------------------------
    _renderDotPanel(title, dotContent) {
        const panel = vscode.window.createWebviewPanel(
            'dotGraphView',
            `CFG: ${title}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    this._context.extensionUri,
                    vscode.Uri.joinPath(this._context.extensionUri, 'webview'),
                ],
            }
        );

        const escaped  = dotContent.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
        const htmlPath = path.join(this._context.extensionUri.fsPath, 'webview', 'imageDot.html');
        let   html     = fs.readFileSync(htmlPath, 'utf8');
        const cssUri   = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'webview', 'imageDot.css')
        );
        html = html
            .replace('/imageDot.css', cssUri.toString())
            .replace('__DOT_CONTENT__', escaped);

        panel.webview.html = html;
    }
   
   async _openDotFromCostabs() {
        const costabsDirWin = path.join(os.homedir(), 'ethir_output_plugin', 'costabs');
        console.log('[openDotFromCostabs] buscando en:', costabsDirWin);
        console.log('[openDotFromCostabs] existe?', fs.existsSync(costabsDirWin));

        if (!fs.existsSync(costabsDirWin)) {
            vscode.window.showWarningMessage('No hay archivos .dot en costabs. Ejecuta CFG primero.');
            return;
        }

        const files = fs.readdirSync(costabsDirWin);
        const dotFiles = files
            .filter(f => f.endsWith('.dot'))
            .map(f => ({
                label: f,
                description: path.join(costabsDirWin, f),
            }));

        if (!dotFiles.length) {
            vscode.window.showWarningMessage('No hay archivos .dot en costabs. Ejecuta CFG primero.');
            return;
        }

        const selected = await vscode.window.showQuickPick(dotFiles, {
            placeHolder: 'Selecciona un archivo .dot para visualizar el grafo',
        });

        if (selected) {
            // Leer directamente con fs en lugar de WSL
            const dotContent = fs.readFileSync(path.join(costabsDirWin, selected.label), 'utf8');
            this._renderDotPanel(selected.label, dotContent);
        }
    }

    // -- Helper: muestra output en canal + picker .dot + picker archivos -----------------------------------
    async _showOutputAndPickDot(output, flags = []) {
        const filtered = this._filterEthirOutput(output, flags);
        this._ethirChannel.clear();
        this._ethirChannel.appendLine(filtered);
        this._ethirChannel.show();
        this._postMessage({ command: 'ethirDone', label: 'Análisis completado' });
        await this._copyEthirFiles(output);
    }

    // -- Comandos EthIR -----------------------------------

   async _runCFG() {
        const filePath = this._requireSolFile(); if (!filePath) return;
        const type = await vscode.window.showQuickPick(
            ['normal', 'memory', 'storage', 'all'],
            { placeHolder: 'Selecciona tipo de CFG' }
        );
        if (!type) return;
        const output = await this._runWithProgress(
            'Ejecutando CFG...',
            () => runCFG(filePath, type, '')
        );
        await this._showOutputAndPickDot(output, [`-cfg`]);
    }

    async _runSaco() {
        const filePath = this._requireSolFile(); if (!filePath) return;
        const output = await this._runWithProgress(
            'Ejecutando SACO...',
            () => runSaco(filePath, '')
        );
        await this._showOutputAndPickDot(output, ['-saco']);
    }

    async _runGastap() {
        const editor = this._requireSolEditor();
        if (!editor) return;

        if (editor.document.isDirty) await editor.document.save();

        const filePath = editor.document.fileName;
        const mode = await vscode.window.showQuickPick(
            ['op', 'mem', 'all'],
            { placeHolder: 'Selecciona modo GASTAP' }
        );
        if (!mode) return;

        const output = await this._runWithProgress(
            'Ejecutando GASTAP...',
            () => runGastap(filePath, mode, '')
        );
        await this._showOutputAndPickDot(output, ['-gastap']);

        const funciones = parseGastapOutput(output, filePath);
        if (funciones.length) {
            highlightFunctionHeadersByCost(editor, funciones, this._decorations);
            this._currentFunctions = funciones;
            this._postMessage({ command: 'updateFunctions', functions: funciones });
            vscode.window.showInformationMessage(`${funciones.length} funciones analizadas con GASTAP`);
        } else {
            vscode.window.showWarningMessage('GASTAP no encontró funciones con coste estimado en la salida');
        }
    }

    async _runC() {
        const filePath = this._requireSolFile(); if (!filePath) return;
        const type = await vscode.window.showQuickPick(
            ['int', 'uint', 'uint256'],
            { placeHolder: 'Selecciona tipo C' }
        );
        if (!type) return;
        const output = await this._runWithProgress(
            'Generando traducción C...',
            () => runCTranslation(filePath, type, '')
        );
        await this._showOutputAndPickDot(output);
    }

    async _runSafevm() {
        const filePath = this._requireSolFile(); if (!filePath) return;

        const cType = await vscode.window.showQuickPick(
            ['int', 'uint', 'uint256'],
            { placeHolder: 'Selecciona tipo C para la traducción' }
        );
        if (!cType) return;

        const solver = await vscode.window.showQuickPick(
            ['cpa', 'verymax', 'seahorn'],
            { placeHolder: 'Selecciona el verificador SAFEVM' }
        );
        if (!solver) return;

        const output = await this._runWithProgress(
            `Ejecutando SAFEVM con ${solver}...`,
            () => runVerify(filePath, cType, solver, '')
        );

        this._ethirChannel.clear();
        this._ethirChannel.appendLine(output);
        this._ethirChannel.show();
        await this._copyEthirFiles(output);
    }

    async _runHashes() {
        const filePath = this._requireSolFile(); if (!filePath) return;
        const output = await this._runWithProgress(
            'Calculando hashes ABI...',
            () => runHashes(filePath, '')
        );
        await this._showOutputAndPickDot(output);
    }

    async _runMemAnalysis() {
        const filePath = this._requireSolFile(); if (!filePath) return;
        const type = await vscode.window.showQuickPick(
            ['baseref', 'offset'],
            { placeHolder: 'Selecciona tipo de análisis de memoria' }
        );
        if (!type) return;
        const output = await this._runWithProgress(
            'Analizando memoria...',
            () => runMemAnalysis(filePath, type, '')
        );
        await this._showOutputAndPickDot(output);
    }

    async _runStorageAnalysis() {
        const filePath = this._requireSolFile(); if (!filePath) return;
        const output = await this._runWithProgress(
            'Analizando storage...',
            () => runStorageAnalysis(filePath, '')
        );
        await this._showOutputAndPickDot(output);
    }

    async _runSolcCompiler() {
        const filePath = this._requireSolFile(); if (!filePath) return;
        const output = await this._runWithProgress(
            'Ejecutando solc...',
            () => runWithSolc(filePath, '')
        );
        await this._showOutputAndPickDot(output);
    }

    async _runVerify() {
        const filePath = this._requireSolFile(); if (!filePath) return;
        const cType = await vscode.window.showQuickPick(
            ['int', 'uint', 'uint256'],
            { placeHolder: 'Selecciona tipo C' }
        );
        if (!cType) return;
        const verifier = await vscode.window.showQuickPick(
            ['cpa', 'verymax', 'seahorn'],
            { placeHolder: 'Selecciona verificador' }
        );
        if (!verifier) return;
        const output = await this._runWithProgress(
            'Verificando...',
            () => runVerify(filePath, cType, verifier, '')
        );
        await this._showOutputAndPickDot(output);
    }

    async _runEthirCombo(flags) {
        const filePath = this._requireSolFile();
        if (!filePath) return;
        if (!flags || !flags.length) {
            vscode.window.showWarningMessage('Selecciona al menos una opción');
            return;
        }

        const output = await this._runWithProgress(
            'Ejecutando EthIR...',
            () => runEthirCombo(filePath, flags)
        );

        await this._showOutputAndPickDot(output, flags);

        const hasGastap = flags.some(f => f.startsWith('-gastap'));
        if (hasGastap) {
            // Necesitamos el editor para decorar
            const editor = vscode.window.visibleTextEditors.find(
                e => e.document.fileName === filePath
            );
            if (editor) {
                const funciones = parseGastapOutput(output, filePath);
                if (funciones.length) {
                    highlightFunctionHeadersByCost(editor, funciones, this._decorations);
                    this._currentFunctions = funciones;
                    this._postMessage({ command: 'updateFunctions', functions: funciones });
                    vscode.window.showInformationMessage(
                        `${funciones.length} funciones analizadas con GASTAP`
                    );
                } else {
                    vscode.window.showWarningMessage(
                        'GASTAP no encontró funciones con coste estimado en la salida'
                    );
                }
            }
        }
    }

    // -- para visualizar los grafos .dot (apertura manual) ----------
    openDotGraph(dotPath) {
        if (!dotPath) {
            vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Abrir archivo .dot',
                filters: { 'Graphviz DOT': ['dot'] },
            }).then(fileUri => {
                if (!fileUri || !fileUri[0]) return;
                this.openDotGraph(fileUri[0].fsPath);
            });
            return;
        }

        const dotContent = fs.readFileSync(dotPath, 'utf8');
        this._renderDotPanel('CFG Graph', dotContent);
    }

    // -- Helpers internos -----------------------------------

    /* Devuelve el editor del último .sol conocido (visible o activo), o muestra un error.
       Garantiza que filePath y editor son siempre coherentes. */
    _requireSolEditor() {
        if (this._lastSolFile) {
            const editor = vscode.window.visibleTextEditors.find(
                e => e.document.fileName === this._lastSolFile
            );
            if (editor) return editor;
        }
        // Fallback: editor activo si es .sol
        const active = vscode.window.activeTextEditor;
        if (active && active.document.fileName.endsWith('.sol')) {
            this._lastSolFile = active.document.fileName;
            return active;
        }
        vscode.window.showErrorMessage('Abre un archivo .sol primero');
        return null;
    }

    /* Devuelve la ruta del último .sol activo, o muestra un error.*/
    _requireSolFile() {
        if (!this._lastSolFile) {
            vscode.window.showErrorMessage('Abre un archivo .sol primero');
            return null;
        }
        return this._lastSolFile;
    }

    /* Muestra una notificación de progreso mientras se ejecuta fn(). */
    _runWithProgress(title, fn) {
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title, cancellable: false },
            fn
        );
    }

    /* Envía un mensaje al webview (sin fallar si no está disponible). */
    _postMessage(msg) {
        if (this._view) this._view.webview.postMessage(msg);
    }

    /* Genera el HTML del sidebar*/
    _getHtmlContent(webview) {
        const htmlPath = path.join(this._context.extensionUri.fsPath, 'webview', 'sideBar.html');
        let   html     = fs.readFileSync(htmlPath, 'utf8');
        const cssUri   = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'webview', 'sideBar.css')
        );
        return html.replace('/sideBar.css', cssUri.toString());
    }
}

module.exports = SidebarProvider;