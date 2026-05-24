const vscode = require('vscode');

// Limpia todas las decoraciones activas del editor
function clearDecorations(decorations) {
    for (const decoration of decorations) {
        decoration.dispose();
    }
    decorations.length = 0;
}


// Resalta las cabeceras de funciones sin información de coste (amarillo)
function highlightFunctionHeaders(editor, funciones, decorations) {
    clearDecorations(decorations);

    const decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 255, 0, 0.2)',
        overviewRulerColor: 'yellow',
        isWholeLine: true,
    });

    // .map() convierte el array de funciones en un array de rangos de línea
    const ranges = funciones.map(func =>
        editor.document.lineAt(func.line - 1).range
        // Resta 1: VS Code usa índices base 0, el archivo usa base 1
    );

    editor.setDecorations(decorationType, ranges);
    decorations.push(decorationType);
}


// Resalta cabeceras de funciones coloreadas según su coste en gas:
function highlightFunctionHeadersByCost(editor, funciones, decorations) {
    clearDecorations(decorations);

    const greenFuncs  = [];
    const orangeFuncs = [];
    const redFuncs    = [];
    const paramFuncs  = [];

    for (const func of funciones) {
        const range = editor.document.lineAt(func.line - 1).range;

        // Si viene de solc y no hay gas, ponemos 'infinite'
        // Si viene de GASTAP, usamos la expresión literal tal cual
        let gasText;
        if (func.source === 'solc') {
            gasText = func.gas === null ? 'infinite' : `${func.gas} gas`;
        } else {
            gasText = func.gasLabel; // expresión literal de GASTAP
        }

        const decoration = {
            range,
            renderOptions: {
                after: {
                    contentText: `  // ${gasText}`,
                    color: 'grey',
                    fontStyle: 'italic',
                },
            },
        };

        if (func.source === 'gastap' && func.gas === null) {
            paramFuncs.push(decoration); 
        } else if (func.gas === null || func.gas > 100000) {
            redFuncs.push(decoration);
        } else if (func.gas > 50000) {
            orangeFuncs.push(decoration);
        } else {
            greenFuncs.push(decoration);
        }
    }

    const colorGroups = [
        { list: greenFuncs,  bg: 'rgba(0, 255, 0, 0.2)',     ruler: 'green'  },
        { list: orangeFuncs, bg: 'rgba(255, 165, 0, 0.2)',   ruler: 'orange' },
        { list: redFuncs,    bg: 'rgba(255, 0, 0, 0.2)',     ruler: 'red'    },
        { list: paramFuncs,  bg: 'rgba(100, 149, 237, 0.2)', ruler: 'blue'   },
    ];

    for (const { list, bg, ruler } of colorGroups) {
        if (!list.length) continue;

        const decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: bg,
            overviewRulerColor: ruler,
            isWholeLine: true,
        });

        editor.setDecorations(decorationType, list);
        decorations.push(decorationType);
    }
}

module.exports = {
    highlightFunctionHeaders,        
    highlightFunctionHeadersByCost, 
    clearDecorations,                
};