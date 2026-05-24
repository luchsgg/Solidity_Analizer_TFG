const vscode = require('vscode');
const SidebarProvider = require('./sidebarProvider');

function activate(context) {
    console.log('[tfg] Extensión activa');

    const sidebarProvider = new SidebarProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('miMenuView', sidebarProvider)
    );
}

function deactivate() {}

module.exports = { activate, deactivate };