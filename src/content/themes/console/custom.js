(function(){
    'use strict';

    function stored(key){
        try { return localStorage.getItem(key); } catch(_){ return null; }
    }

    function store(key, value){
        try { localStorage.setItem(key, value); } catch(_){}
    }

    function setInitialMode(){
        if(stored('view-theme') === null && typeof updateTheme === 'function')
            updateTheme('dark');
    }

    function installSidebarToggle(){
        var nav = document.querySelector('body > nav.navbar > .container');
        if(!nav || nav.querySelector('.xc-console-sidebar-toggle')) return;
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'xc-console-sidebar-toggle d-none d-lg-block';
        button.setAttribute('aria-label', 'Toggle console sidebar');
        button.textContent = 'Toggle sidebar';
        button.addEventListener('click', function(){
            var collapsed = document.body.classList.toggle('xc-console-sidebar-collapsed');
            store('xc-console-sidebar', collapsed ? 'collapsed' : 'open');
        });
        nav.insertBefore(button, nav.firstChild);
        if(stored('xc-console-sidebar') === 'collapsed')
            document.body.classList.add('xc-console-sidebar-collapsed');
    }

    function tileValue(source){
        var value = source.textContent.trim();
        return value || 'Waiting';
    }

    function mountTile(host, source, spec){
        XCComponents.mount(host, 'stat-tile', {
            label: spec.label,
            value: tileValue(source),
            hint: 'Live explorer data',
            icon: spec.icon
        });
    }

    function addTile(grid, spec){
        var source = document.getElementById(spec.source);
        if(!source) return;
        var host = document.createElement('div');
        grid.appendChild(host);
        mountTile(host, source, spec);
        new MutationObserver(function(){
            mountTile(host, source, spec);
        }).observe(source, { childList: true, characterData: true, subtree: true });
    }

    function installLiveStats(){
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
        for(var i = 0; i < specs.length; i++) addTile(grid, specs[i]);
        anchor.closest('.container').parentNode.insertBefore(grid, anchor.closest('.container'));
    }

    function start(){
        document.body.classList.add('xc-console-theme');
        setInitialMode();
        installSidebarToggle();
        installLiveStats();
    }

    if(document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', start);
    else
        start();
})();
