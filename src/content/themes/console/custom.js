'use strict';

function xcConsoleStored(key){
    try { return localStorage.getItem(key); } catch(_){ return null; }
}

function xcConsoleStore(key, value){
    try { localStorage.setItem(key, value); } catch(_){}
}

function xcConsoleSetInitialMode(){
    if(xcConsoleStored('view-theme') === null && typeof updateTheme === 'function')
        updateTheme('dark');
}

function xcConsoleInstallSidebarToggle(){
    var nav = document.querySelector('body > nav.navbar > .container');
    if(!nav || nav.querySelector('.xc-console-sidebar-toggle')) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'xc-console-sidebar-toggle d-none d-lg-block';
    button.setAttribute('aria-label', 'Toggle console sidebar');
    button.textContent = 'Toggle sidebar';
    button.addEventListener('click', function(){
        var collapsed = document.body.classList.toggle('xc-console-sidebar-collapsed');
        xcConsoleStore('xc-console-sidebar', collapsed ? 'collapsed' : 'open');
    });
    nav.insertBefore(button, nav.firstChild);
    if(xcConsoleStored('xc-console-sidebar') === 'collapsed')
        document.body.classList.add('xc-console-sidebar-collapsed');
}

function xcConsoleTileValue(source){
    var value = source.textContent.trim();
    return value || 'Waiting';
}

function xcConsoleMountTile(host, source, spec){
    XCComponents.mount(host, 'stat-tile', {
        label: spec.label,
        value: xcConsoleTileValue(source),
        hint: 'Live explorer data',
        icon: spec.icon
    });
}

function xcConsoleAddTile(grid, spec){
    var source = document.getElementById(spec.source);
    if(!source) return;
    var host = document.createElement('div');
    grid.appendChild(host);
    xcConsoleMountTile(host, source, spec);
    new MutationObserver(function(){
        xcConsoleMountTile(host, source, spec);
    }).observe(source, { childList: true, characterData: true, subtree: true });
}

function xcConsoleInstallLiveStats(){
    if(typeof XCComponents === 'undefined') return;
    var anchor = document.getElementById('xchain-stats-header');
    if(!anchor || document.querySelector('.xc-console-stats')) return;
    var grid = document.createElement('section');
    grid.className = 'xc-console-stats';
    grid.setAttribute('aria-label', 'Live network statistics');
    var specs = [
        { source: 'network-block-index', label: 'Block height', icon: 'fa-cube' },
        { source: 'network-unconfirmed', label: 'Unconfirmed', icon: 'fa-clock' },
        { source: 'xchain-price', label: 'XChain price', icon: 'fa-chart-line' },
        { source: 'total-tokens', label: 'Tokens', icon: 'fa-database' }
    ];
    for(var i = 0; i < specs.length; i++) xcConsoleAddTile(grid, specs[i]);
    anchor.closest('.container').parentNode.insertBefore(grid, anchor.closest('.container'));
}

function xcConsoleStart(){
    document.body.classList.add('xc-console-theme');
    xcConsoleSetInitialMode();
    xcConsoleInstallSidebarToggle();
    xcConsoleInstallLiveStats();
}

if(document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', xcConsoleStart);
else
    xcConsoleStart();
