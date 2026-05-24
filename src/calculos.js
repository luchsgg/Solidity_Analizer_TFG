const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const vscode = require('vscode');

/*************************************************************************/
// las rutas se leen desde la configuración de VSCode,
// con valores por defecto que el usuario puede sobreescribir en settings.json
/*************************************************************************/
function getConfig() {
    const config = vscode.workspace.getConfiguration('tfg');
    const home = os.homedir(); // → C:\Users\quien_sea
    
    return {
        solcPath: config.get('solcPath') 
            || toWSLPath(path.join(home, '.local', 'bin', 'solc')),
        ethirPath: config.get('ethirPath') 
            || toWSLPath(path.join(home, 'solidity-analizer', 'EthIR', 'ethir', 'ethir.py')),
    };
}

/*************************************************************************/
// PARSEO BÁSICO DE FUNCIONES
//
// Lee un archivo .sol línea por línea y busca definiciones de funciones
// usando una expresión regular.
//
// Por cada función encontrada, guarda:
//   - name: nombre de la función
//   - line: número de línea (base 1)
//   - gas:  inicialmente 0 (aún no analizado)
//
// REGEX: /function\s+(\w+)\s*\([^)]*\)/
//   function\s+  → palabra "function" seguida de espacios
//   (\w+)        → nombre de la función
//   \s*          → espacios opcionales
//   \([^)]*\)    → parámetros entre paréntesis
/*************************************************************************/
function parseSolidityFile(filePath) {
    const source = fs.readFileSync(filePath, 'utf8');
    const lines  = source.split('\n');
    const funciones = [];

    lines.forEach((line, index) => {
        const match = line.match(/function\s+(\w+)\s*\([^)]*\)/);
        if (match) {
            funciones.push({ name: match[1], line: index + 1, gas: 0 });
        }
    });

    return funciones;
}

function analyzeContract(filePath) {
    return parseSolidityFile(filePath);
}

/*************************************************************************/
// EJECUCIÓN DE SOLC CON --gas / --bin-runtime
//
// Ejecuta el compilador de Solidity y devuelve una Promise con los resultados.
//   --gas:         estima el coste en gas de cada función.
//   --bin-runtime: genera el bytecode de la parte de ejecución.
/*************************************************************************/
function executeSolcGas(filePath) {
    return new Promise((resolve, reject) => {
        const { solcPath } = getConfig();
        const wslFilePath = toWSLPath(filePath);
        const cmd = `wsl ${solcPath} "${wslFilePath}" --gas --bin-runtime`;

        exec(cmd, (error, stdout, stderr) => {
            if (error) return reject(error);

            const funciones = parseSolcOutput(stdout + stderr, filePath);
            if (!funciones.length) return reject(new Error('No se encontraron funciones en la salida de solc'));
            resolve(funciones);
        });
    });
}

/*************************************************************************/
// INTERPRETACIÓN DE LA SALIDA DE SOLC
//
// Busca la sección `external:` donde solc lista las funciones públicas con
// su coste estimado en gas. Por cada línea que encaje con el patrón:
//
//   functionName(...) : gasCost
//
// Extrae nombre y coste, y localiza el número de línea en el fuente.
/*************************************************************************/
function parseSolcOutput(output, filePath) {
    const funciones   = [];
    const lines       = output.split('\n');
    const sourceLines = fs.readFileSync(filePath, 'utf8').split('\n');
    let inExternal    = false;

    lines.forEach(line => {
        line = line.trim();

        if (line === 'external:') { inExternal = true;  return; }
        if (inExternal && line.endsWith(':') && line !== 'external:') inExternal = false;

        if (inExternal && line) {
            // Ignoramos líneas que correspondan a eventos o modificadores
            // (empiezan por mayúscula o no tienen patrón nombre+paréntesis)
            const match = line.match(/^([a-z]\w*)\([^)]*\)\s*:\s*(\d+|infinite)/);
            if (match) {
                const name = match[1];
                const gas  = match[2] === 'infinite' ? 999999 : parseInt(match[2], 10);
                const lineNumber = findFunctionLine(sourceLines, name);
                if (lineNumber) funciones.push({ name, line: lineNumber, gas: gas, gasLabel: `${gas} gas`, source: 'solc' });
            }
        }
    });

    return funciones;
}

function findFunctionLine(sourceLines, functionName) {
    const regex = new RegExp(`function\\s+${functionName}\\s*\\(`);
    for (let i = 0; i < sourceLines.length; i++) {
        if (regex.test(sourceLines[i])) return i + 1;
    }
    return 0;
}

/*************************************************************************/
// CONVERSIÓN DE RUTAS Windows → WSL
//
// Transforma  C:\Users\lucia\archivo.sol
// en          /mnt/c/Users/lucia/archivo.sol
//
// Necesario porque EthIR corre dentro de WSL (Linux) pero los archivos
// están en el sistema de archivos de Windows.
/*************************************************************************/
function toWSLPath(filePath) {
    return filePath
        .replace(/\\/g, '/')
        .replace(/^([A-Za-z]):/, (_, letter) => `/mnt/${letter.toLowerCase()}`);
}

/*************************************************************************/
// FUNCIÓN CENTRAL: EJECUTAR ETHIR
//
// Construye y ejecuta un comando WSL de la forma:
//   wsl python3 /ruta/ethir.py -s "/mnt/c/.../archivo.sol" [flags] [extraFlags]
//                               -solc-compiler /ruta/solc
//
// El flag -solc-compiler se añade automáticamente salvo que ya venga incluido
// en flags/extraFlags, para que EthIR siempre encuentre el compilador
// independientemente de dónde esté el archivo .sol analizado.
//
// Devuelve una Promise que resuelve con la salida combinada (stdout + stderr).
// Todas las funciones de EthIR son envoltorios de esta.
/*************************************************************************/
function runEthir(filePath, flags, extraFlags) {
    return new Promise((resolve, reject) => {
        const { ethirPath, solcPath } = getConfig();
        const wslPath    = filePath ? toWSLPath(filePath) : '';
        const sourcePart = filePath ? `-s "${wslPath}"` : '';

        // Añadimos -solc-compiler automáticamente si ninguno de los flags ya lo incluye
        const allFlags = `${flags} ${extraFlags}`;
        const solcFlag = allFlags.includes('-solc-compiler')
            ? ''
            : `-solc-compiler ${solcPath}`;

        const cmd = `wsl python3 ${ethirPath} ${sourcePart} ${flags} ${solcFlag} ${extraFlags}`.trim()
            .replace(/\s{2,}/g, ' '); // limpiar espacios dobles

        exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve(stdout + stderr);
        });
    });
}

/*************************************************************************/
//  INTERPRETACIÓN DE LA SALIDA DE GASTAP
// Busca la sección GASTAPRES: donde EthIR lista el coste de cada función.
// Maneja tres patrones de salida habituales:
//
//   1. cost(block0_functionName_entry/N,...): nat(X)
//      → formato de bloque estándar de EthIR
//   2. functionName/N: nat(X)
//      → formato compacto
//   3. Upper bound for functionName: nat(X)
//      → formato de cota superior
//
// Si el coste no es un número concreto (expresión simbólica), se marca
// como 999999 (infinite) para colorearlo en rojo.
/*************************************************************************/
function parseGastapOutput(output, filePath) {
    const sourceLines = fs.readFileSync(filePath, 'utf8').split('\n');
    const funciones   = [];
    const seen        = new Set();

    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('GASTAPRES:')) continue;

        const parts = trimmed.split(';');
        if (parts.length < 8 || parts[6].trim() !== 'ok') continue;

        const gasLabel   = parts[7].trim(); // expresión literal: "22227" o "259+26376*nat(a)"
        const gasNumeric = /^\d+$/.test(gasLabel) ? parseInt(gasLabel, 10) : null; // null si es paramétrico

        const funcWithArgs = parts[3].trim();
        const name = funcWithArgs.replace(/\(.*\)/, '');

        if (!name || seen.has(name)) continue;

        const lineNumber = findFunctionLine(sourceLines, name);
        if (lineNumber) {
          funciones.push({ name, line: lineNumber, gas: gasNumeric, gasLabel, source: 'gastap' });
          seen.add(name);
        }
    }
    return funciones;
}

/*************************************************************************/
// COMANDOS DE ETHIR
//
// Función              Flag                    Descripción
/*************************************************************************/
// runCFG               -cfg <type>             Grafo de flujo de control
// runSaco              -saco                   Analizador SACO de coste
// runGastap            -gastap <mode>          Estimación estática de gas
// runCTranslation      -c <type>               Traducción a código C
// runVerify            -c <type> -v <verifier> Traducción + verificación formal
// runHashes            -hashes                 Selectores ABI (hashes)
// runMemAnalysis       -mem-analysis <type>    Análisis de uso de memoria
// runStorageAnalysis   -storage-analysis       Análisis de storage
// runWithSolc          -solc-compiler <ruta>   Compilador solc específico
// runOptimizeRun       -optimize-run [-run N]  Optimización con N iteraciones
// runNoYulOpt          -no-yul-opt             Desactiva optimización Yul
// runViaIR             -via-ir                 Compila vía representación IR
/*************************************************************************/
function runCFG(filePath, type, extraFlags) {
    return runEthir(filePath, `-cfg ${type}`, extraFlags);
}

function runSaco(filePath, extraFlags) {
    return runEthir(filePath, '-saco', extraFlags);
}

function runGastap(filePath, mode, extraFlags) {
    return runEthir(filePath, `-gastap ${mode}`, extraFlags);
}

function runCTranslation(filePath, type, extraFlags) {
    return runEthir(filePath, `-c ${type}`, extraFlags);
}

function runVerify(filePath, cType, verifier, extraFlags) {
    return runEthir(filePath, `-c ${cType} -v ${verifier}`, extraFlags);
}

function runHashes(filePath, extraFlags) {
    const { solcPath } = getConfig();
    return runEthir(filePath, `-hashes -solc-compiler ${solcPath}`, extraFlags);
}

function runMemAnalysis(filePath, type, extraFlags) {
    return runEthir(filePath, `-mem-analysis ${type}`, extraFlags);
}

function runStorageAnalysis(filePath, extraFlags) {
    return runEthir(filePath, '-storage-analysis', extraFlags);
}

function runWithSolc(filePath, extraFlags) {
    const { solcPath } = getConfig();
    return runEthir(filePath, `-solc-compiler ${solcPath}`, extraFlags);
}

function runOptimizeRun(filePath, runs, extraFlags) {
    const runsPart = runs ? `-run ${runs}` : '';
    return runEthir(filePath, `-optimize-run ${runsPart}`, extraFlags);
}

function runNoYulOpt(filePath, extraFlags) {
    return runEthir(filePath, '-no-yul-opt', extraFlags);
}

function runViaIR(filePath, extraFlags) {
    return runEthir(filePath, '-via-ir', extraFlags);
}

function runEthirCombo(filePath, flags) {
    return runEthir(filePath, flags.join(' '), '');
}

module.exports = {
    parseSolidityFile,
    analyzeContract,
    executeSolcGas,
    parseSolcOutput,
    findFunctionLine,
    toWSLPath,
    runCFG,
    runSaco,
    runGastap,
    runCTranslation,
    runVerify,
    runHashes,
    runMemAnalysis,
    runStorageAnalysis,
    runWithSolc,
    runOptimizeRun,
    runNoYulOpt,
    runViaIR,
    runEthirCombo,
    parseGastapOutput,
};