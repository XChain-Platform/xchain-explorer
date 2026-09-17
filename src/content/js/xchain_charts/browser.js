/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain chart layer (XCC)
 */
'use strict';

var xcChartsRoot = (typeof self !== 'undefined') ? self : this;
var api = (typeof module === 'object' && module.exports)
    ? Object.assign({}, require('./data.js'), require('./configs.js'))
    : xcChartsRoot.XCC;
var xcChartsRanges = api.RANGES,
        xcChartsRangeWindow = api.rangeWindow,
        xcChartsIsEmptyConfig = api.isEmptyConfig;

    // ------------------------------------------------------------------
    // Browser layer. Skipped under Node so the module stays require()-able.
    // ------------------------------------------------------------------
    var xcChartsInstances = {};

    function xcChartsTooltipElement(){
        var el = document.getElementById('xc-chart-tooltip');
        if(!el){
            el = document.createElement('div');
            el.id = 'xc-chart-tooltip';
            el.className = 'xc-chart-tooltip';
            document.body.appendChild(el);
        }
        return el;
    }

    // Chart.js only ships a canvas-drawn tooltip; the market tooltips are HTML
    // tables, so they are rendered into a floating div positioned off the
    // canvas rect (the useHTML:true equivalent).
    function xcChartsExternalTooltip(build){
        return function(context){
            var el      = xcChartsTooltipElement(),
                tooltip = context.tooltip;
            if(!tooltip || tooltip.opacity === 0){
                el.style.opacity = 0;
                return;
            }
            var html = build(tooltip.dataPoints || []);
            if(!html){
                el.style.opacity = 0;
                return;
            }
            el.innerHTML = html;
            var rect = context.chart.canvas.getBoundingClientRect();
            el.style.opacity = 1;
            el.style.left = (rect.left + window.pageXOffset + tooltip.caretX + 12) + 'px';
            el.style.top  = (rect.top  + window.pageYOffset + tooltip.caretY + 12) + 'px';
        };
    }

    function xcChartsButton(label, title){
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm btn-outline-secondary xc-chart-btn';
        b.innerHTML = label;
        if(title) b.title = title;
        return b;
    }

    function xcChartsDownloadPng(chart, name){
        var a = document.createElement('a');
        a.href = chart.toBase64Image('image/png', 1);
        a.download = (name || 'chart') + '.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function xcChartsBuildToolbar(container, chart, opts){
        var bar = document.createElement('div');
        bar.className = 'xc-chart-toolbar';

        if(opts.rangeSelector){
            var group = document.createElement('div');
            group.className = 'btn-group btn-group-sm xc-chart-ranges';
            group.setAttribute('role', 'group');
            group.setAttribute('aria-label', 'Chart zoom');
            xcChartsRanges.forEach(function(range, idx){
                var b = xcChartsButton(range.label, 'Zoom: ' + range.label);
                b.setAttribute('data-range', range.key);
                if(range.key === opts.range) b.classList.add('active');
                b.addEventListener('click', function(){
                    group.querySelectorAll('button').forEach(function(x){ x.classList.remove('active'); });
                    b.classList.add('active');
                    try { localStorage.setItem('marketChartZoom', idx); } catch(e){ /* private mode */ }
                    var win = xcChartsRangeWindow(range.key, opts.maxTs);
                    if(win){
                        chart.options.scales.x.min = win.min;
                        chart.options.scales.x.max = win.max;
                    } else {
                        delete chart.options.scales.x.min;
                        delete chart.options.scales.x.max;
                    }
                    chart.update('none');
                });
                group.appendChild(b);
            });
            bar.appendChild(group);
        }

        var save = xcChartsButton('<i class="fa fa-download"></i>', 'Download PNG');
        save.className += ' xc-chart-export';
        save.addEventListener('click', function(){ xcChartsDownloadPng(chart, opts.name); });
        bar.appendChild(save);

        container.appendChild(bar);
    }

    /**
     * Draw a config into a container element, replacing whatever was there.
     * opts: { name, height, rangeSelector, range, maxTs, noData }
     */
    function xcChartsRender(containerId, config, opts){
        opts = opts || {};
        var container = document.getElementById(containerId);
        if(!container) return null;

        if(xcChartsInstances[containerId]){
            xcChartsInstances[containerId].destroy();
            delete xcChartsInstances[containerId];
        }
        container.innerHTML = '';
        container.classList.add('xc-chart');

        if(xcChartsIsEmptyConfig(config)){
            var msg = document.createElement('div');
            msg.className = 'xc-chart-nodata';
            msg.textContent = opts.noData || 'No data found';
            container.appendChild(msg);
            return null;
        }

        var wrap = document.createElement('div');
        wrap.className = 'xc-chart-canvas';
        wrap.style.height = (opts.height || 400) + 'px';
        var canvas = document.createElement('canvas');
        wrap.appendChild(canvas);

        if(config.xcTooltip)
            config.options.plugins.tooltip.external = xcChartsExternalTooltip(config.xcTooltip);

        // Toolbar is appended before the canvas so it sits above the plot, but
        // it needs the chart instance, so the canvas is constructed first.
        container.appendChild(wrap);
        var chart = new Chart(canvas.getContext('2d'), config);
        xcChartsBuildToolbar(container, chart, opts);
        container.insertBefore(container.lastChild, wrap);

        xcChartsInstances[containerId] = chart;
        return chart;
    }

    function xcChartsDestroy(containerId){
        if(xcChartsInstances[containerId]){
            xcChartsInstances[containerId].destroy();
            delete xcChartsInstances[containerId];
        }
    }

var xcChartsBrowserPart = {
        render: xcChartsRender,
        destroy: xcChartsDestroy,
        externalTooltip: xcChartsExternalTooltip,
        instances: xcChartsInstances
    };

if(typeof module === 'object' && module.exports){
    module.exports = xcChartsBrowserPart;
} else {
    xcChartsRoot.XCC = Object.assign(xcChartsRoot.XCC || {}, xcChartsBrowserPart);
}
