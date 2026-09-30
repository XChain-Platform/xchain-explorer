function xcTimelineItem(doc, item){
    'use strict';
    item = item || {};
    var row = doc.createElement('li');
    var state = String(item.state || 'pending').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
    row.className = 'xc-timeline-item xc-timeline-' + state;
    row.setAttribute('data-state', state);
    var marker = doc.createElement('span');
    marker.className = 'xc-timeline-marker';
    marker.setAttribute('aria-hidden', 'true');
    var body = doc.createElement('div');
    body.className = 'xc-timeline-body';
    var label = doc.createElement('div');
    label.className = 'xc-timeline-label fw-semibold';
    label.textContent = item.label == null ? '' : String(item.label);
    body.appendChild(label);
    if(item.detail != null){
        var detail = doc.createElement('div');
        detail.className = 'xc-timeline-detail';
        detail.textContent = String(item.detail);
        body.appendChild(detail);
    }
    if(item.meta != null){
        var meta = doc.createElement('div');
        meta.className = 'xc-timeline-meta text-muted small';
        meta.textContent = String(item.meta);
        body.appendChild(meta);
    }
    row.appendChild(marker);
    row.appendChild(body);
    return row;
}

if(typeof window !== 'undefined') window.XCTimelineItem = xcTimelineItem;
if(typeof module !== 'undefined' && module.exports) module.exports = xcTimelineItem;
