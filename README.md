# Solidity_Analizer
 
Una extensión de Visual Studio Code para el análisis estático de contratos inteligentes de Ethereum mediante el framework **EthIR**. Permite detectar vulnerabilidades y analizar bytecode directamente desde el editor, conectando la interfaz de VSCode en Windows con las herramientas de análisis que se ejecutan en WSL.
 
## Características
 
- **Análisis de contratos desde VSCode**: ejecuta análisis estático sobre ficheros `.sol` sin salir del editor.
- **Integración con EthIR**: aprovecha el framework EthIR para analizar código fuente Solidity, bytecode EVM y ficheros desensamblados.
- **Puente Windows + WSL**: la extensión gestiona la comunicación entre la interfaz de VSCode en Windows y el motor de análisis que corre dentro de WSL (Ubuntu). 

## Requisitos
 
Esta extensión requiere un entorno WSL correctamente configurado con varias herramientas instaladas. Sigue los pasos a continuación **en orden**.
 
### Software base (Windows)
 
| Requisito | Versión mínima |
|-----------|---------------|
| Visual Studio Code | 1.70 |
| Node.js | 16 |
| WSL (Ubuntu) | 20.04 |

### Instalación de Node.js (Windows)
 
Descarga e instala Node.js (versión 16 o superior) desde [nodejs.org](https://nodejs.org/). Puedes verificar la instalación con:
 
```bash
node --version
npm --version
 
### Herramientas de análisis (WSL — Ubuntu)
 
Todo lo siguiente debe instalarse **dentro de WSL**, no en Windows.
 
#### 1. Compilador de Solidity (`solc`)
 
Clona el [repositorio de EthIR](https://github.com/costa-group/EthIR) — incluye el directorio `source/` con los binarios estáticos del compilador que requiere la extensión. Se utilizan binarios estáticos de [Argot Collective](https://github.com/argotorg/solidity) para dar soporte a contratos de cualquier versión.
 
```bash
sudo cp source/solc* /usr/bin/
sudo chmod 755 /usr/bin/solc*
solc --version
solcv5 --version
solcv6 --version
```
 
Alternativamente, instala la última versión mediante PPA:
 
```bash
sudo add-apt-repository ppa:ethereum/ethereum
sudo apt-get update
sudo apt-get install solc
```
 
O usa `solc-select` para gestionar múltiples versiones:
 
```bash
pip3 install solc-select
solc-select install all
```
 
#### 2. Máquina Virtual de Ethereum (`evm`)
 
Instalación estática (recomendada):
 
```bash
sudo cp source/evm* /usr/bin/
sudo chmod 755 /usr/bin/evm*
evm --version
```
 
O instala mediante PPA:
 
```bash
sudo apt-get install software-properties-common
sudo add-apt-repository -y ppa:ethereum/ethereum
sudo apt-get update
sudo apt-get install ethereum
```
 
#### 3. Solver Z3
 
Descarga el código fuente, compila e instala:
 
```bash
unzip z3-z3-4.5.0.zip
cd z3-z3-4.5.0
python scripts/mk_make.py --python
cd build
make
sudo make install
```
 
#### 4. Dependencias de Python 3
 
```bash
pip3 install six requests semantic_version
```
 
Si encuentras problemas con `pip3`:
 
```bash
python3 -m pip install six requests semantic_version
```
 
#### 5. EthIR
 
Una vez instaladas todas las dependencias, verifica que EthIR funciona ejecutando alguno de los siguientes comandos desde su directorio:
 
```bash
# Desde un fichero Solidity
./ethir.py -s file_name.sol
 
# Desde bytecode EVM
./ethir.py -s file_name.evm -b
 
# Desde un fichero desensamblado
./ethir.py -s file_name.disasm -disasm
```
 
> **Importante:** asegúrate de que todas las herramientas instaladas están correctamente añadidas al `PATH` de WSL. Comprueba las versiones instaladas para evitar incompatibilidades con EthIR.
 
## Configuración de la extensión
 
Esta extensión no añade por ahora configuraciones adicionales a VS Code mediante `contributes.configuration`. Se añadirán ajustes en versiones futuras.
 
## Problemas conocidos
 
- La extensión requiere que WSL esté correctamente configurado y accesible desde Windows. Si WSL no se detecta, el análisis no se ejecutará.
- Los binarios estáticos del directorio `source/` deben provenir del repositorio de EthIR — la extensión fallará si no encuentra dicha carpeta.
- Los conflictos de versión de Python pueden impedir la instalación de dependencias; usa `python3 -m pip` como alternativa.
## Notas de versión
 
### 1.0.0
 
Versión inicial de `solidity-analizer`:
- Integración con EthIR mediante WSL.
- Soporte para los formatos de entrada `.sol`, `.evm` y `.disasm`.
- Análisis lanzado desde la paleta de comandos de VSCode.
---
## Más información
 
- [Repositorio de EthIR](https://github.com/costa-group/EthIR)
- [Argot Collective — Binarios estáticos de solc](https://github.com/argotorg/solidity)
- [API de extensiones de Visual Studio Code](https://code.visualstudio.com/api)
- [Guía de instalación de WSL](https://learn.microsoft.com/es-es/windows/wsl/install)

 ## Configuración recomendada para VS Code (WSL)

Para que el proyecto y las extensiones funcionen correctamente dentro de WSL, añade esta configuración a tu archivo local `settings.json` de Visual Studio Code.

### Pasos para configurarlo:
1. En VS Code (conectado a tu instancia de WSL), abre la paleta de comandos (`Ctrl + Shift + P`).
2. Escribe **"Preferences: Open User Settings (JSON)"** y selecciónalo.
3. Añade las siguientes líneas dentro del objeto JSON principal, cambiando `<tu_usuario_wsl>` por tu nombre de usuario real en Linux:

```json
{
  "workbench.colorTheme": "Shades of Purple (Super Dark)",
  "git.autofetch": true,
  "redhat.telemetry.enabled": true,
  "liveServer.settings.donotShowInfoMsg": true,
  "git.confirmSync": false,
  "files.autoSave": "afterDelay",
  "tfg-lucia.solcPath": "/home/<tu_usuario_wsl>/.solc-select/artifacts/solc-0.5.17/solc-0.5.17"
}
