let currentViewMode = 'net'; // Default
let savedPeople = []; // Global list of names
let allTransactions = []; // Global variable to hold data for filtering
let isModalPaymentMode = false; // Tracks if the current modal is for a payment
let _currentEditAmount = null;  // Amount of the transaction currently open in the edit modal

// Populated from the JSON embed on page load; updated via loadCategories() after any mutation.
let TRACKED_CATEGORIES = JSON.parse(document.getElementById('trackedCategoriesData').textContent);

async function loadCategories() {
    const res = await fetch('/api/categories');
    TRACKED_CATEGORIES = await res.json();
    setupCategoryDropdowns();
    renderCategoryList();
}

const PAYMENT_CATEGORIES = ['Work', 'Venmo Payment', 'Investment Return', 'Gift', 'Other'];

// 2. The Function to populate the dropdowns
function setupCategoryDropdowns() {
    // These IDs should match the <select> elements in your HTML
    const ruleSelect = document.getElementById('ruleCategory');
    const filterSelect = document.getElementById('filterCategory');
    const selects = [ruleSelect, filterSelect, document.getElementById('addCategory'), document.getElementById('editCategory'), document.getElementById('breakdownCategory')];

    selects.forEach(select => {
        if (!select) return;
        
        // For the filter dropdown, preserve ALL static options (All Categories +
        // Uncategorized) that were set in the HTML — only the dynamic category
        // options below need to be rebuilt.
        let staticOptions = [];
        if (select.id === 'filterCategory') {
            staticOptions = Array.from(select.options).filter(o =>
                o.value === '' || o.value === '__uncategorized__'
            );
        }
        if (select.id === 'breakdownCategory') {
            staticOptions = Array.from(select.options).filter(o => o.value === '');
        }

        // Clear the dropdown
        select.innerHTML = '';
        
        // Restore static options first
        staticOptions.forEach(o => select.appendChild(o));

        // Add the 10 categories from our Master List
        TRACKED_CATEGORIES.forEach(cat => {
            const option = document.createElement('option');
            option.value = cat;
            option.text = cat;
            select.appendChild(option);
        });
    });
}

// File upload handling
document.getElementById('csvFile').addEventListener('change', function(e) {
    const fileName = e.target.files[0]?.name || 'No file chosen';
    document.getElementById('fileName').textContent = fileName;
});

// Handle form submission
document.getElementById('uploadForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    const formData = new FormData();
    const fileInput = document.getElementById('csvFile');
    const statusDiv = document.getElementById('uploadStatus');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    
    // --- NEW: Get the Selected Bank Name ---
    const bankSelect = document.getElementById('bankSelect');
    const customBankInput = document.getElementById('customBankName');
    
    // Logic: if 'Other' is picked, use the text input, otherwise use the dropdown value
    let selectedBank = bankSelect.value;
    if (selectedBank === 'Other') {
        selectedBank = customBankInput.value.trim() || 'Other';
    }
    
    if (!fileInput.files[0]) {
        showStatus('Please select a file', 'error');
        return;
    }
    
    // Add both the file and the bank name to the request
    formData.append('file', fileInput.files[0]);
    formData.append('bank_name', selectedBank); // Sending this to app.py
    
    // Disable button during upload
    submitBtn.disabled = true;
    submitBtn.textContent = 'Uploading...';
    
    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showStatus(`Success! Uploaded ${result.message}`, 'success');
            
            // Reset form fields
            fileInput.value = '';
            customBankInput.value = '';
            bankSelect.selectedIndex = 0; 
            document.getElementById('customBankWrapper').style.display = 'none';
            document.getElementById('fileName').textContent = 'No file chosen';

            // Refresh data displays
            loadSummary();
            loadFullTransactions(); // This will refresh the Master List and Tables

            setTimeout(() => {
                const overviewBtn = document.querySelector("button[onclick*='overview']");
                if (overviewBtn) {
                    overviewBtn.click();
                }
            }, 1500);
        } else {
            showStatus(`Error: ${result.error}`, 'error');
        }
    } catch (error) {
        showStatus(`Error: ${error.message}`, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Upload & Process';
    }
});


function showStatus(message, type) {
    const statusDiv = document.getElementById('uploadStatus');
    statusDiv.textContent = message;
    statusDiv.className = `status-message ${type}`;
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
        statusDiv.style.display = 'none';
    }, 5000);
}

function updateMonthDropdownGeneric(yearSelectId, monthSelectId) {
    const yearSelect = document.getElementById(yearSelectId);
    const monthSelect = document.getElementById(monthSelectId);
    if (!yearSelect || !monthSelect) return;

    const selectedYear = yearSelect.value;
    if (monthSelect.dataset.lastYear === selectedYear) return;
    monthSelect.dataset.lastYear = selectedYear;

    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed (0 = Jan, 11 = Dec)

    const previousValue = monthSelect.value;
    let maxMonth = 11;
    if (parseInt(selectedYear) === currentYear) {
        maxMonth = currentMonth;
    }

    monthSelect.innerHTML = '';
    for (let i = 0; i <= maxMonth; i++) {
        const option = document.createElement('option');
        option.value = String(i + 1).padStart(2, '0');
        option.text = months[i];
        monthSelect.appendChild(option);
    }

    if (previousValue && parseInt(previousValue) <= maxMonth + 1) {
        monthSelect.value = previousValue;
    } else {
        monthSelect.value = String(maxMonth + 1).padStart(2, '0');
    }
}

function updateMonthDropdown() {
    updateMonthDropdownGeneric('yearSelect', 'monthSelect');
}

function updateBreakdownMonthDropdown() {
    updateMonthDropdownGeneric('breakdownYear', 'breakdownMonth');
}

// Load monthly summary
async function loadSummary(clearCache = false) {
    if (clearCache) _apiCache.clear();

    const yearSelect = document.getElementById('yearSelect');
    const monthSelect = document.getElementById('monthSelect');

    // Safety check: if dropdowns aren't ready, don't fetch
    if (!yearSelect || !monthSelect || !yearSelect.value) return;

    updateMonthDropdown();

    const year = yearSelect.value;
    const month = monthSelect.value;

    try {
        // Phase 1: render the chart the user sees first — give it exclusive server access
        await loadCurrentOverviewChart();

        // Start Sankey prefetch immediately after chart renders — user will read it for a few
        // seconds before clicking slide 1, giving the prefetch time to resolve
        _prefetchSankeyData();

        // Phase 2: fire everything else in parallel while the user reads the chart
        const [response] = await Promise.all([
            fetch(`/api/detailed-summary?year=${year}&month=${month}`),
            loadOverviewInsights(),
            loadAccountBreakdown(),
        ]);

        const data = await response.json();
        _overviewTableData = {
            monthly: data.month_totals,
            yearly:  data.year_totals,
            average: data.year_averages
        };
        try { renderActiveOverviewTable(); } catch (e) { console.error('Overview render failed: overviewTable', e); }

        // Phase 2 complete — all threads free; prefetch shared ledger while user reads the overview
        _prefetchSharedLedger();
    } catch (error) {
        console.error('Error loading summary:', error);
    }
}

let overviewChartRange = '6m'; // Default chart range for the Monthly Spending Trend graph
let overviewSlide = 0;    // 0 = bar chart, 1 = Sankey
let sankeyAvgMode = false; // false = Total, true = Avg/mo
// URL-keyed cache: first request fires a real fetch, repeats (e.g. gross↔net toggles) resolve instantly
const _apiCache = new Map();
function _cachedFetch(url) {
    if (!_apiCache.has(url)) _apiCache.set(url, fetch(url).then(r => r.json()));
    return _apiCache.get(url);
}
let _overviewTableMode = 'monthly';
let _overviewTableData = {};
let _overviewInsightData = {};
let _overviewHistory = null;

function switchOverviewTable(mode) {
    _overviewTableMode = mode;
    ['monthly', 'yearly', 'average'].forEach(m => {
        const btn = document.getElementById('btnTable' + m.charAt(0).toUpperCase() + m.slice(1));
        if (!btn) return;
        btn.style.background = m === mode ? 'var(--surface-2)' : 'none';
        btn.style.color = m === mode ? 'var(--ink)' : 'var(--muted)';
    });
    renderActiveOverviewTable();
}

function renderActiveOverviewTable() {
    const yearSelect = document.getElementById('yearSelect');
    const monthSelect = document.getElementById('monthSelect');
    if (!yearSelect || !monthSelect) return;
    const year = yearSelect.value;
    const monthLabel = monthSelect.options[monthSelect.selectedIndex]?.text || '';

    const titleEl = document.getElementById('overviewTableTitle');
    if (titleEl) {
        const titles = {
            monthly: `Monthly: ${monthLabel}`,
            yearly:  `Yearly Total (${year})`,
            average: 'Yearly Average'
        };
        titleEl.textContent = titles[_overviewTableMode] || '';
    }

    updateOverviewTable('overviewTable', _overviewTableData[_overviewTableMode] || {});

    const insightEl = document.getElementById('overviewInsight');
    if (insightEl && _overviewInsightData[_overviewTableMode] != null) {
        insightEl.innerHTML = _overviewInsightData[_overviewTableMode];
    }
}

function setOverviewSlide(index) {
    overviewSlide = index;
    const titles = ['Monthly Spending Trend', 'Income Flow'];
    document.getElementById('overviewChartTitle').textContent = titles[index];

    document.getElementById('overviewHistoryChart').style.display = index === 0 ? 'block' : 'none';
    document.getElementById('overviewSankeyChart').style.display  = index === 1 ? 'block' : 'none';

    const leftBtn  = document.getElementById('slideLeft');
    const rightBtn = document.getElementById('slideRight');
    leftBtn.style.opacity       = index === 0 ? '0.3' : '1';
    leftBtn.style.pointerEvents = index === 0 ? 'none' : 'auto';
    rightBtn.style.opacity       = index === 1 ? '0.3' : '1';
    rightBtn.style.pointerEvents = index === 1 ? 'none' : 'auto';

    document.querySelectorAll('.slide-dot').forEach(dot => {
        dot.style.background = dot.dataset.slide === String(index) ? '#764ba2' : '#ccc';
    });

    updateSankeyToggleVisibility();

    if (index === 0) loadOverviewHistoryChart();
    else             loadSankeyChart();
}

function updateSankeyToggleVisibility() {
    const toggle = document.getElementById('sankeyAvgToggle');
    if (!toggle) return;
    const show = overviewSlide === 1 && overviewChartRange !== '1m';
    toggle.style.display = show ? 'flex' : 'none';
}

function setSankeyAvgMode(avg) {
    sankeyAvgMode = avg;
    document.getElementById('btnSankeyTotal').classList.toggle('active', !avg);
    document.getElementById('btnSankeyAvg').classList.toggle('active', avg);
    loadSankeyChart();
}

function setOverviewChartRange(event, range) {
    overviewChartRange = range;
    // Update active button styling (scoped to this chart's controls only)
    const container = event.currentTarget.closest('.chart-time-controls');
    container.querySelectorAll('.time-btn').forEach(btn => btn.classList.remove('active'));
    event.currentTarget.classList.add('active');
    updateSankeyToggleVisibility();
    loadCurrentOverviewChart();
}

function loadCurrentOverviewChart() {
    if (overviewSlide === 0) loadOverviewHistoryChart();
    else                     loadSankeyChart();
}

function _prefetchSankeyData() {
    const year  = document.getElementById('yearSelect').value;
    const month = document.getElementById('monthSelect').value;
    if (!year || !month) return;
    const url = `/api/sankey-data?${new URLSearchParams({ year, month, view_mode: currentViewMode, time_range: overviewChartRange })}`;
    _cachedFetch(url); // warms the cache; result reused by loadSankeyChart
}

async function loadSankeyChart() {
    const year  = document.getElementById('yearSelect').value;
    const month = document.getElementById('monthSelect').value;
    if (!year || !month) return;

    const url = `/api/sankey-data?${new URLSearchParams({ year, month, view_mode: currentViewMode, time_range: overviewChartRange })}`;
    const data = await _cachedFetch(url);

    const divisor = sankeyAvgMode ? (data.months_in_range || 1) : 1;
    const income     = data.income / divisor;
    const categories = data.categories.map(c => ({ ...c, total: c.total / divisor }));
    const totalExpenses = categories.reduce((s, c) => s + c.total, 0);
    const savings = income - totalExpenses;

    const catColors = {
        'Streaming': '#34A77B', 'Transportation': '#5B9BD5', 'Food/Drink': '#D2A859',
        'Shopping': '#9B7BD0', 'Utilities': '#E0795F', 'Healthcare': '#4FB6A8',
        'Entertainment': '#D27FB0', 'Housing': '#8FB04F', 'Personal Care': '#7E8AA0',
        'Other': '#C2596B'
    };

    const nodeLabels   = ['Income', ...categories.map(c => c.name)];
    const nodeColors   = ['#43e97b', ...categories.map(c => catColors[c.name] || '#888888')];
    // customdata holds the "true" value for each node so the hover is always accurate.
    // Plotly's %{value} on a source node shows outgoing-flow totals, not the query result —
    // using customdata lets the Income node show actual income rather than total expenses.
    const nodeCustom   = [income, ...categories.map(c => c.total)];

    const sources = categories.map(() => 0);
    const targets = categories.map((_, i) => i + 1);
    const values  = categories.map(c => c.total);

    if (savings > 0.01) {
        nodeLabels.push('Savings');
        nodeColors.push('#27ae60');
        nodeCustom.push(savings);
        sources.push(0);
        targets.push(nodeLabels.length - 1);
        values.push(savings);
    } else if (savings < -0.01) {
        // Deficit month: add a red source node for the shortfall so the chart balances
        const deficit = Math.abs(savings);
        const deficitIdx = nodeLabels.length;
        nodeLabels.push('Deficit');
        nodeColors.push('#e74c3c');
        nodeCustom.push(deficit);
        // Spread the deficit across categories proportionally
        categories.forEach((cat, i) => {
            sources.push(deficitIdx);
            targets.push(i + 1);
            values.push((cat.total / totalExpenses) * deficit);
        });
    }

    const hexA = (hex, a) => {
        const h = hex.replace('#', '');
        const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
        return `rgba(${r},${g},${b},${a})`;
    };

    // Manual node positions so Savings sits clearly below the expense categories.
    // x: 0=left edge, 1=right edge. y: 0=top, 1=bottom (Plotly Sankey convention).
    const nCats = categories.length;
    const hasSavings = savings > 0.01;
    const hasDeficit = savings < -0.01;

    const nodeX = [0.01]; // Income: far left
    const nodeY = [0.5];  // Income: vertically centred

    // Expense categories occupy the top 68% of the right column (or full height if no savings)
    const catBotY = hasSavings ? 0.66 : 0.95;
    categories.forEach((_, i) => {
        nodeX.push(0.99);
        nodeY.push(nCats > 1 ? 0.02 + (i / (nCats - 1)) * (catBotY - 0.02) : (0.02 + catBotY) / 2);
    });

    if (hasSavings) {
        nodeX.push(0.99);
        nodeY.push(0.95); // Savings: far bottom-right, visually separated
    } else if (hasDeficit) {
        nodeX.push(0.01);
        nodeY.push(0.88); // Deficit: bottom-left
    }

    // On mobile swap the Sankey for a readable text summary — the diagram is too dense at small widths
    if (isMobile()) {
        document.getElementById('overviewSankeyChart').style.display = 'none';
        const label = sankeyAvgMode ? '/mo' : '';
        const fmt = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const savingsColor = savings >= 0 ? '#27ae60' : '#e74c3c';
        const savingsLabel = savings >= 0 ? 'Savings' : 'Deficit';
        const catRows = categories.map(c =>
            `<div class="sankey-summary-row">
                <span class="sankey-summary-cat">${c.name}</span>
                <span class="sankey-summary-val" style="color:#C9CDD3;">${fmt(c.total)}${label}</span>
            </div>`
        ).join('');
        document.getElementById('sankeyMobileSummary').style.display = 'block';
        document.getElementById('sankeyMobileSummary').innerHTML = `
            <div class="sankey-summary-block">
                <div class="sankey-summary-row sankey-summary-header">
                    <span>Income</span>
                    <span style="color:#43e97b;">${fmt(income)}${label}</span>
                </div>
                <div class="sankey-summary-divider"></div>
                ${catRows}
                <div class="sankey-summary-divider"></div>
                <div class="sankey-summary-row sankey-summary-header">
                    <span>${savingsLabel}</span>
                    <span style="color:${savingsColor};">${fmt(Math.abs(savings))}${label}</span>
                </div>
            </div>`;
        return;
    }

    document.getElementById('sankeyMobileSummary').style.display = 'none';
    document.getElementById('overviewSankeyChart').style.display = 'block';

    const trace = {
        type: 'sankey',
        orientation: 'h',
        arrangement: 'fixed',
        node: {
            pad: 12, thickness: 20,
            line: { color: 'rgba(0,0,0,0)', width: 0 },
            label: nodeLabels,
            color: nodeColors,
            customdata: nodeCustom,
            x: nodeX,
            y: nodeY,
            hovertemplate: '<b>%{label}</b><br>$%{customdata:,.2f}<extra></extra>'
        },
        link: {
            source: sources,
            target: targets,
            value: values,
            color: targets.map(t => hexA(nodeColors[t], 0.35)),
            hovertemplate: '%{source.label} → %{target.label}<br>$%{value:,.2f}<extra></extra>'
        }
    };

    Plotly.newPlot('overviewSankeyChart', [trace], {
        font: { color: '#C9CDD3', family: 'Schibsted Grotesk, sans-serif', size: 12 },
        margin: { t: 10, b: 10, l: 10, r: 10 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor:  'rgba(0,0,0,0)',
    }, { responsive: true, displayModeBar: false });
}

async function loadOverviewHistoryChart() {
    const yearSelect = document.getElementById('yearSelect');
    const monthSelect = document.getElementById('monthSelect');
    if (!yearSelect || !monthSelect || !yearSelect.value) return;

    const year = yearSelect.value;
    const month = monthSelect.value;

    const params = new URLSearchParams({ year, month, view_mode: currentViewMode, time_range: overviewChartRange });

    try {
        const data = await _cachedFetch(`/api/overview-history?${params.toString()}`);

        // Same palette used by the pie charts, so a category's color stays consistent across the page
        const colors = ['#34A77B', '#5B9BD5', '#D2A859', '#9B7BD0', '#E0795F', '#4FB6A8', '#D27FB0', '#8FB04F', '#7E8AA0', '#C2596B'];

        // Helper: hex -> rgba with alpha, for translucent stacked-area fills
        const hexA = (hex, a) => {
            const h = hex.replace('#', '');
            const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${a})`;
        };

        const singleMonth = data.months.length === 1;

        // For multiple months: stacked-area chart. For a single month: stacked bar chart
        // (a scatter line with one point renders nothing, so we switch to bars).
        const visibleTraces = TRACKED_CATEGORIES
            .map((cat, i) => {
                const y = data.categories[cat] || [];
                if (!y.some(v => Math.abs(v) > 0.01)) return null;
                const color = colors[i % colors.length];
                if (singleMonth) {
                    return {
                        x: data.months, y,
                        name: cat,
                        type: 'bar',
                        marker: { color: hexA(color, 0.82) },
                        hovertemplate: `<b>${cat}</b>: $%{y:,.2f}<extra></extra>`
                    };
                }
                return {
                    x: data.months, y,
                    name: cat,
                    type: 'scatter',
                    mode: 'lines',
                    stackgroup: 'one',
                    line: { width: 0.8, color },
                    fillcolor: hexA(color, 0.82),
                    hovertemplate: `<b>${cat}</b>: $%{y:,.2f}<extra></extra>`
                };
            })
            .filter(Boolean);

        // Invisible total-hover trace (multi-month only — bar chart shows per-category tooltips)
        const monthTotals = data.months.map((_, mi) =>
            TRACKED_CATEGORIES.reduce((sum, cat) => sum + (data.categories[cat]?.[mi] || 0), 0)
        );
        const totalTrace = {
            x: data.months,
            y: monthTotals,
            type: 'scatter',
            mode: 'lines',
            line: { width: 0 },
            hovertemplate: 'Total spent: <b>$%{y:,.2f}</b><extra></extra>',
            showlegend: false
        };

        // Dashed reference line — avg for multi-month, total for single month.
        // Uses layout.shapes so it renders correctly even with only one x-point.
        const chartAvg = monthTotals.length
            ? monthTotals.reduce((s, v) => s + v, 0) / monthTotals.length
            : null;
        const avgShape = chartAvg != null ? [{
            type: 'line',
            xref: 'paper', yref: 'y',
            x0: 0, x1: 1,
            y0: chartAvg, y1: chartAvg,
            line: { color: '#8E949E', width: 1.5, dash: 'dash' }
        }] : [];
        const avgAnnotation = chartAvg != null ? [{
            xref: 'paper', yref: 'y',
            x: 1, y: chartAvg,
            xanchor: 'right', yanchor: 'bottom',
            text: singleMonth
                ? `total $${Math.round(chartAvg).toLocaleString('en-US')}`
                : `avg $${Math.round(chartAvg).toLocaleString('en-US')}/mo`,
            showarrow: false,
            font: { color: '#8E949E', size: 11, family: 'Schibsted Grotesk, sans-serif' },
            bgcolor: 'rgba(53,58,66,0.85)',
            borderpad: 3
        }] : [];

        const chartData = singleMonth ? visibleTraces : [...visibleTraces, totalTrace];

        const mobile = isMobile();
        const layout = {
            font: { color: '#C9CDD3', family: 'Schibsted Grotesk, sans-serif' },
            xaxis: {
                title: mobile ? '' : 'Month',
                tickfont: { color: '#A2A7B0', size: mobile ? 9 : 11 },
                tickangle: mobile ? -55 : 0,
                gridcolor: 'rgba(0,0,0,0)',
                linecolor: '#565C66',
                ...(singleMonth ? { range: [-0.5, 0.5] } : {})
            },
            yaxis: {
                title: mobile ? '' : 'Total Spend ($)',
                tickprefix: '$',
                tickfont: { color: '#A2A7B0', size: mobile ? 9 : 11 },
                gridcolor: '#4D535D',
                zerolinecolor: '#565C66',
                rangemode: 'tozero'
            },
            barmode: singleMonth ? 'stack' : undefined,
            bargap: singleMonth ? 0 : undefined,
            margin: chartMargins(mobile ? { b: 70 } : {}),
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            hovermode: 'x unified',
            hoverlabel: {
                bgcolor: '#2C3037',
                bordercolor: '#565C66',
                font: { color: '#F3F4F5', family: 'Schibsted Grotesk, sans-serif', size: 13 }
            },
            showlegend: true,
            legend: { orientation: 'h', x: 0, y: mobile ? -0.45 : -0.3, font: { color: '#C9CDD3', size: mobile ? 10 : 12 } },
            shapes: avgShape,
            annotations: avgAnnotation
        };

        Plotly.newPlot('overviewHistoryChart', chartData, layout, { responsive: true, displayModeBar: false });
    } catch (error) {
        console.error('Error loading overview history chart:', error);
    }
}

// Load recent transactions
async function loadTransactions() {
    try {
        const response = await fetch('/api/transactions');
        const data = await response.json();
        
        const transactionsDiv = document.getElementById('transactionsList');
        
        if (data.length === 0) {
            transactionsDiv.innerHTML = '<p class="loading">No transactions yet.</p>';
            return;
        }
        
        transactionsDiv.innerHTML = data.map(txn => `
            <div class="transaction-item" id="txn-${txn.id}">
                <div class="transaction-info">
                    <div class="transaction-description">${txn.description}</div>
                    <div class="transaction-meta">
                        ${formatDate(txn.date)} • ${txn.merchant || 'Unknown'}
                        ${txn.category ? `<span class="transaction-category">${txn.category}</span>` : ''}
                    </div>
                </div>
                <div class="transaction-right">
                    <div class="transaction-amount">$${Math.abs(txn.amount).toFixed(2)}</div>
                    <button class="btn-delete" onclick="deleteTransaction(${txn.id})">Delete</button>
                </div>
            </div>
        `).join('');

        
    } catch (error) {
        console.error('Error loading transactions:', error);
    }
}

function renderPieChart(divId, dataMap) {
    const chartDiv = document.getElementById(divId);
    if (!chartDiv) return;
    const map = dataMap || {};   // tolerate a missing/undefined section without throwing

    const categories = TRACKED_CATEGORIES.filter(cat => {
        const entry = map[cat] || { gross: 0, net: 0 };
        const amount = (entry && typeof entry === 'object') ? 
            ((currentViewMode === 'gross') ? entry.gross : entry.net) : entry;
        return Math.abs(amount) > 0.01; // Filter out tiny amounts for cleaner charts
    });

    const values = categories.map(cat => {
        const entry = map[cat] || { gross: 0, net: 0 };
        const amount = (entry && typeof entry === 'object') ? 
            ((currentViewMode === 'gross') ? entry.gross : entry.net) : entry;
        return Math.abs(amount || 0);
    });

    if (values.length === 0) {
        chartDiv.innerHTML = '<p class="loading">No data to display for this period</p>';
        return;
    }

    const maxV = Math.max(...values);
    const chartData = [{
        x: categories,
        y: values,
        type: 'bar',
        marker: {
            color: values.map(v => `rgba(52, 167, 123, ${(0.42 + 0.55 * (v / maxV)).toFixed(2)})`)
        },
        hovertemplate: '<b>%{x}</b><br>$%{y:,.2f}<extra></extra>'
    }];

    const mobile = isMobile();
    const layout = {
        height: mobile ? 240 : 350,
        margin: { t: 12, b: mobile ? 60 : 95, l: mobile ? 36 : 58, r: 12 },
        showlegend: false,
        font: { color: '#C9CDD3', family: 'Schibsted Grotesk, sans-serif' },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        bargap: 0.35,
        xaxis: { tickangle: mobile ? -55 : -40, tickfont: { color: '#A2A7B0', size: mobile ? 9 : 11 }, gridcolor: 'rgba(0,0,0,0)' },
        yaxis: { tickprefix: '$', tickfont: { color: '#A2A7B0', size: mobile ? 9 : 11 }, gridcolor: '#4D535D', zerolinecolor: '#565C66' }
    };

    Plotly.newPlot(divId, chartData, layout, {responsive: true, displayModeBar: false});
}


// Context panels beside the three Overview tables. Everything is computed from the
// /api/overview-history series the app already loads — no backend change. Any comparison
// that lacks history (e.g. no prior-year data) renders "—" instead of a misleading jump.
async function loadOverviewInsights() {
    const yearSelect = document.getElementById('yearSelect');
    const monthSelect = document.getElementById('monthSelect');
    if (!yearSelect || !monthSelect || !yearSelect.value) return;

    try {
        const year = yearSelect.value;
        const month = monthSelect.value;
        // Pull a wide window so year-over-year stats light up automatically once prior-year data exists.
        const params = new URLSearchParams({ year, month, view_mode: currentViewMode, time_range: '5y' });
        const data = await _cachedFetch(`/api/overview-history?${params.toString()}`);
        _overviewHistory = data;
        const months = data.months || [];
        const cats = data.categories || {};
        const n = months.length;
        if (!n) return;

        // ---- helpers ----
        const MABBR = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
        const short = lbl => (lbl || '').split(' ')[0];
        const mnum  = lbl => MABBR[short(lbl)] || 0;
        const money0 = v => '$' + Math.round(v).toLocaleString('en-US');
        const money2 = v => '$' + (v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const kAbbr  = v => Math.abs(v) >= 10000 ? '$' + (v / 1000).toFixed(1) + 'k' : money0(v);
        const COLORS = ['#34A77B','#5B9BD5','#D2A859','#9B7BD0','#E0795F','#4FB6A8','#D27FB0','#8FB04F','#7E8AA0','#C2596B'];
        const colorOf = c => COLORS[Math.max(0, TRACKED_CATEGORIES.indexOf(c)) % COLORS.length];

        // per-month total; a zero month means "no data" (app has no history before its first record)
        const totals = months.map((_, i) => TRACKED_CATEGORIES.reduce((s, c) => s + ((cats[c] && cats[c][i]) || 0), 0));
        const hasData = totals.map(t => Math.abs(t) > 0.005);

        // Spending: lower = good (green ↓), higher = bad (coral ↑). Returns "—" with no baseline.
        const chip = (cur, base) => {
            if (base == null || !(Math.abs(base) > 0.005)) return '<span class="ins-chip none">—</span>';
            const pct = (cur - base) / base * 100;
            const up = pct >= 0;
            return `<span class="ins-chip ${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%</span>`;
        };
        const row = (label, val) => `<div class="ins-row"><span class="ins-label">${label}</span><span class="ins-val">${val}</span></div>`;

        // ===== MONTHLY (selected month = last in window) =====
        const L = n - 1;
        const cur = totals[L];
        const prev = (L - 1 >= 0 && hasData[L - 1]) ? totals[L - 1] : null;
        const prior3 = [L - 1, L - 2, L - 3].filter(i => i >= 0 && hasData[i]);
        const avg3 = prior3.length ? prior3.reduce((s, i) => s + totals[i], 0) / prior3.length : null;
        const sameLY = (L - 12 >= 0 && hasData[L - 12]) ? totals[L - 12] : null;

        const now = new Date();
        const isCurrent = (parseInt(year) === now.getFullYear() && parseInt(month) === now.getMonth() + 1);
        const daysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
        const daysElapsed = isCurrent ? Math.max(1, now.getDate()) : daysInMonth;
        const dailyPace = cur / daysElapsed;

        let mover = null, moverDiff = 0;
        TRACKED_CATEGORIES.forEach(c => {
            const ser = cats[c] || [];
            const pr = prior3.map(i => ser[i] || 0);
            if (!pr.length) return;
            const cavg = pr.reduce((a, b) => a + b, 0) / pr.length;
            const diff = (ser[L] || 0) - cavg;
            if (Math.abs(diff) > Math.abs(moverDiff)) { moverDiff = diff; mover = c; }
        });

        let mSub;
        if (prev != null) { const d = cur - prev; mSub = `${money0(Math.abs(d))} ${d < 0 ? 'less' : 'more'} than ${short(months[L - 1])}`; }
        else { mSub = 'First recorded month'; }

        _overviewInsightData.monthly = `
            <div class="ins-tag">vs. recent months</div>
            <div class="ins-hero"><span class="ins-big">${money0(cur)}</span>${chip(cur, prev)}</div>
            <div class="ins-sub">${mSub}</div>
            <div class="ins-div"></div>
            ${row('3-month average', avg3 != null ? money0(avg3) : '—')}
            ${row('vs. same month last year', chip(cur, sameLY))}
            ${row('Daily pace', money2(dailyPace))}
            ${mover ? `<div class="ins-div"></div><div class="ins-tag">Biggest mover</div>
            <div class="ins-row"><span class="ins-mover"><span class="ins-dot" style="background:${colorOf(mover)}"></span><span class="ins-label">${mover}</span></span><span class="ins-val ${moverDiff >= 0 ? 'neg' : 'pos'}">${moverDiff >= 0 ? '+' : '−'}${money0(Math.abs(moverDiff))} vs avg</span></div>` : ''}
        `;

        // ===== YEARLY TOTAL (selected year) =====
        const yStr = String(year), lyStr = String(parseInt(year) - 1);
        const tyIdx = months.map((m, i) => i).filter(i => months[i].endsWith(yStr) && hasData[i]);
        const ytd = tyIdx.reduce((s, i) => s + totals[i], 0);
        const monthsElapsed = tyIdx.length || 1;
        const projection = ytd / monthsElapsed * 12;
        const avgMonth = ytd / monthsElapsed;

        const lyIdx = months.map((m, i) => i).filter(i => months[i].endsWith(lyStr) && hasData[i]);
        const tyNums = tyIdx.map(i => mnum(months[i]));
        const lySame = lyIdx.filter(i => tyNums.includes(mnum(months[i])));
        const lyPaceTotal = (lySame.length === tyNums.length && lySame.length > 0) ? lySame.reduce((s, i) => s + totals[i], 0) : null;
        const lyFull = lyIdx.length ? lyIdx.reduce((s, i) => s + totals[i], 0) : null;

        const tyTotals = tyIdx.map(i => totals[i]);
        const sparkMax = Math.max(...tyTotals, 1);
        const spark = tyTotals.length
            ? `<div class="ins-spark">${tyTotals.map((v, k) => `<span style="height:${Math.max(8, v / sparkMax * 100)}%;${k === tyTotals.length - 1 ? 'opacity:1;' : ''}"></span>`).join('')}</div>`
            : '';

        _overviewInsightData.yearly = `
            <div class="ins-tag">vs. last year &amp; pace</div>
            <div class="ins-hero"><span class="ins-big">${kAbbr(ytd)}</span>${chip(ytd, lyPaceTotal)}</div>
            <div class="ins-sub">${monthsElapsed} ${monthsElapsed === 1 ? 'month' : 'months'} recorded${lyPaceTotal != null ? ` · ${money0(Math.abs(ytd - lyPaceTotal))} ${ytd < lyPaceTotal ? 'under' : 'over'} last year's pace` : ''}</div>
            <div class="ins-div"></div>
            ${row('Full-year projection', '~' + kAbbr(projection))}
            ${row('Last year', lyFull != null ? kAbbr(lyFull) : '—')}
            ${row('Avg / month so far', money0(avgMonth))}
            ${spark ? `<div class="ins-div"></div><div class="ins-tag">Spend by month</div>${spark}` : ''}
        `;

        // ===== YEARLY AVERAGE (selected year) =====
        let hi = { v: -Infinity, l: '' }, lo = { v: Infinity, l: '' };
        tyIdx.forEach(i => { if (totals[i] > hi.v) hi = { v: totals[i], l: months[i] }; if (totals[i] < lo.v) lo = { v: totals[i], l: months[i] }; });
        let swing = null;
        if (tyTotals.length >= 2) { let s = 0; for (let k = 1; k < tyTotals.length; k++) s += Math.abs(tyTotals[k] - tyTotals[k - 1]); swing = s / (tyTotals.length - 1); }

        const cv = [];
        TRACKED_CATEGORIES.forEach(c => {
            const ser = tyIdx.map(i => (cats[c] && cats[c][i]) || 0);
            const mean = ser.reduce((a, b) => a + b, 0) / (ser.length || 1);
            if (mean < 1) return;
            const variance = ser.reduce((a, b) => a + (b - mean) ** 2, 0) / ser.length;
            cv.push({ c, v: Math.sqrt(variance) / mean });
        });
        cv.sort((a, b) => a.v - b.v);
        const lyAvg = (lyFull != null && lyIdx.length) ? lyFull / lyIdx.length : null;

        _overviewInsightData.average = `
            <div class="ins-tag">typical month, ${year}</div>
            <div class="ins-hero"><span class="ins-big">${money0(avgMonth)}</span>${chip(avgMonth, lyAvg)}</div>
            <div class="ins-sub">${lyAvg != null ? `${money0(Math.abs(avgMonth - lyAvg))} ${avgMonth < lyAvg ? 'lower' : 'higher'} than last year` : 'Per-month average across ' + monthsElapsed + ' ' + (monthsElapsed === 1 ? 'month' : 'months')}</div>
            <div class="ins-div"></div>
            ${row('Highest month', hi.l ? `${short(hi.l)} · ${money0(hi.v)}` : '—')}
            ${row('Lowest month', lo.l ? `${short(lo.l)} · ${money0(lo.v)}` : '—')}
            ${row('Month-to-month swing', swing != null ? '±' + money0(swing) : '—')}
            ${cv.length ? `<div class="ins-div"></div><div class="ins-note">Most consistent: <b>${cv[0].c}</b> · Most variable: <b>${cv[cv.length - 1].c}</b></div>` : ''}
        `;

        renderActiveOverviewTable();
    } catch (e) {
        console.error('Overview insights failed:', e);
    }
}



// Utility functions
function formatMonth(monthStr) {
    if (!monthStr) return '';
    
    // monthStr is 'YYYY-MM'
    const [year, month] = monthStr.split('-');
    const date = new Date(year, month - 1, 1);
    
    return date.toLocaleDateString('en-US', { 
        month: 'long', 
        year: 'numeric' 
    });
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    
    // If the date string contains a time component (e.g., "2026-05-27 10:30:00"), 
    // we only want the date part for our display.
    const datePart = dateStr.split(' ')[0]; // Splits "YYYY-MM-DD HH:MM:SS" into ["YYYY-MM-DD", "HH:MM:SS"]
    
    const [year, month, day] = datePart.split('-');
    
    // Creating the date using (year, monthIndex, day) in LOCAL time
    const date = new Date(year, month - 1, day);
    
    return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric' 
    });
}

function fmtAppliedDate(d) {
    return d ? formatDate(d) : '';
}

function addSplitRow(date = '', amount = '', note = '') {
    const container = document.getElementById('splitRowsContainer');
    const row = document.createElement('div');
    row.className = 'split-row';
    row.style.cssText = 'display:flex; gap:6px; align-items:center;';
    const inputStyle = 'background:var(--field); color:var(--ink); border:1px solid var(--border); border-radius:4px; padding:6px; font-family:inherit;';
    row.innerHTML = `
        <input type="date" class="split-date" value="${date}"
               style="${inputStyle}" oninput="updateSplitTotal()">
        <span style="font-weight:bold; color:var(--muted);">$</span>
        <input type="number" class="split-amount" value="${amount}" step="0.01" placeholder="Amount"
               style="${inputStyle} width:90px;" oninput="updateSplitTotal()">
        <input type="text" class="split-note" value="${note}" placeholder="Note (optional)"
               style="${inputStyle} flex:1;">
        <button type="button" onclick="removeSplitRow(this)"
                style="background:var(--neg); color:#fff; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; flex-shrink:0;">✕</button>
    `;
    container.appendChild(row);
    updateSplitTotal();
}

function removeSplitRow(btn) {
    btn.closest('.split-row').remove();
    updateSplitTotal();
}

function updateSplitTotal() {
    const total = Array.from(document.querySelectorAll('.split-amount'))
        .reduce((s, i) => s + (parseFloat(i.value) || 0), 0);
    const el = document.getElementById('splitTotalDisplay');
    el.textContent = total > 0 ? `Total: $${total.toFixed(2)}` : '';
}

async function deleteTransaction(txnId) {
    const txn = allTransactions.find(t => t.id === txnId);
    let msg = 'Are you sure you want to delete this transaction?';
    
    if (txn && txn.settlement_count > 0) {
        msg = 'This transaction is involved in settlements. Deleting it will remove those settlement records and make the associated amounts due again. Are you sure?';
    }

    if (!confirm(msg)) return;

    try {
        const response = await fetch(`/api/transaction/${txnId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            // 1. Refresh the master list of transactions from the server
            // This also automatically calls updateBankCategoryDropdown() and filterTransactions()
            await loadFullTransactions();

            // 2. Refresh the Overview tables (Monthly/Yearly/Avg) since totals changed
            loadSummary(true);
        } else {
            alert('Failed to delete transaction from database');
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

function updateOverviewTable(tableId, dataMap) {
    const container = document.getElementById(tableId);
    if (!container) return;
    const map = dataMap || {};   // tolerate a missing/undefined section without throwing

    // 1. Resolve each category's amount (respecting the gross/net toggle).
    //    Keep each category's index so its bar color stays consistent across the page.
    const CATEGORY_COLORS = ['#34A77B', '#5B9BD5', '#D2A859', '#9B7BD0', '#E0795F', '#4FB6A8', '#D27FB0', '#8FB04F', '#7E8AA0', '#C2596B'];
    const rows = TRACKED_CATEGORIES.map((cat, i) => {
        const entry = map[cat] || { gross: 0, net: 0 };
        let amount = 0;
        if (entry && typeof entry === 'object') {
            amount = (currentViewMode === 'gross') ? (entry.gross || 0) : (entry.net || 0);
        } else {
            amount = entry; // Fallback for simple number arrays
        }
        return { cat, amount: Math.abs(amount) || 0, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length] };
    });

    const grandTotal = rows.reduce((s, r) => s + r.amount, 0);
    const maxAmount = Math.max(...rows.map(r => r.amount), 0);

    // 2. Build MoM delta lookup (monthly mode only)
    let priorAmounts = null;
    if (_overviewTableMode === 'monthly' && _overviewHistory) {
        const yearEl = document.getElementById('yearSelect');
        const monthEl = document.getElementById('monthSelect');
        const MABBR = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const curLabel = MABBR[parseInt(monthEl?.value || '0')] + ' ' + (yearEl?.value || '');
        const idx = (_overviewHistory.months || []).indexOf(curLabel);
        if (idx > 0) {
            priorAmounts = {};
            TRACKED_CATEGORIES.forEach(c => {
                const ser = (_overviewHistory.categories || {})[c] || [];
                const prev = ser[idx - 1];
                priorAmounts[c] = (prev && typeof prev === 'object') ? (currentViewMode === 'gross' ? (prev.gross || 0) : (prev.net || 0)) : (prev || 0);
            });
        }
    }

    // 3. Hide empty categories and sort biggest-spend first
    const visible = rows.filter(r => r.amount > 0.005).sort((a, b) => b.amount - a.amount);

    // 4. Render as a horizontal-bar breakdown (category · bar · amount · % of total · MoM delta)
    container.innerHTML = visible.map(r => {
        const pct = grandTotal > 0 ? (r.amount / grandTotal * 100) : 0;
        const barPct = maxAmount > 0 ? (r.amount / maxAmount * 100) : 0;
        const amtStr = r.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        let deltaInner = '';
        if (priorAmounts !== null) {
            const prior = priorAmounts[r.cat] || 0;
            if (prior > 0.005) {
                const delta = (r.amount - prior) / prior * 100;
                const up = delta >= 0;
                deltaInner = `<span class="ins-chip ${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${Math.abs(delta).toFixed(0)}%</span>`;
            } else {
                deltaInner = `<span class="ins-chip none">—</span>`;
            }
        }
        const deltaBadge = deltaInner
            ? `<div style="width:72px; flex-shrink:0; display:flex; justify-content:flex-end;">${deltaInner}</div>`
            : '';
        return `
            <div class="cat-row">
                <div class="cat-name">${r.cat}</div>
                <div class="cat-track"><div class="cat-fill" style="width:${barPct.toFixed(1)}%; background:${r.color};"></div></div>
                <div class="cat-amount">$${amtStr}</div>
                <div class="cat-pct">${Math.round(pct)}%</div>
                ${deltaBadge}
            </div>
        `;
    }).join('') || '<div class="loading">No spending in this period</div>';

    // 5. Update the total shown in the section header
    const totalLabel = `$${grandTotal.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
    const totalEl = document.getElementById('overviewTotalVal');
    if (totalEl) totalEl.textContent = totalLabel;
}

async function saveRule() {
    const keyword = document.getElementById('ruleKeyword').value;
    const category = document.getElementById('ruleCategory').value;
    const amount = document.getElementById('ruleAmount').value; // Get the amount
    
    if(!keyword) return alert("Enter a keyword");

    const response = await fetch('/api/rules', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ 
            keyword, 
            category, 
            amount: amount ? parseFloat(amount) : null 
        })
    });

    if (response.ok) {
        document.getElementById('ruleKeyword').value = '';
        document.getElementById('ruleAmount').value = '';
        //loadRules();
        loadSummary(true);
        loadFullTransactions();
    }
}

//async function loadRules() {
//    const response = await fetch('/api/rules');
//    const rules = await response.json();
//    const body = document.getElementById('rulesBody');
//    body.innerHTML = rules.map(r => `
//        <tr>
//            <td>${r.keyword}</td>
//            <td>${r.amount ? '$' + Math.abs(r.amount).toFixed(2) : 'Any'}</td>
//            <td>${r.category}</td>
//            <td><button onclick="deleteRule(${r.id})" class="btn-delete">Delete</button></td>
//        </tr>
//    `).join('');
//}


async function openTab(evt, tabId) {
    const currentTarget = evt ? evt.currentTarget : null;
    let targetBtn = currentTarget;
    if (!targetBtn && tabId) {
        const buttons = document.getElementsByClassName("tab-btn");
        for (let i = 0; i < buttons.length; i++) {
            const onclickAttr = buttons[i].getAttribute("onclick");
            if (onclickAttr && onclickAttr.includes(tabId)) {
                targetBtn = buttons[i];
                break;
            }
        }
    }

    const tabcontent = document.getElementsByClassName("tab-content");
    for (let i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
        tabcontent[i].classList.remove("active");
    }

    const tablinks = document.getElementsByClassName("tab-btn");
    for (let i = 0; i < tablinks.length; i++) {
        tablinks[i].classList.remove("active");
    }

    // Sync bottom nav active state
    const bottomNavBtns = document.getElementsByClassName("bottom-nav-btn");
    for (let i = 0; i < bottomNavBtns.length; i++) {
        bottomNavBtns[i].classList.remove("active");
        if (bottomNavBtns[i].dataset.tab === tabId) {
            bottomNavBtns[i].classList.add("active");
        }
    }

    const selectedTab = document.getElementById(tabId);
    if (selectedTab) {
        selectedTab.style.display = "block";
        selectedTab.classList.add("active");
    }
    
    // Load data based on which tab is opened
    if (tabId === 'overview') {
        loadSummary(); 
    } else if (tabId === 'transactions') {
        loadFullTransactions();
    } else if (tabId === 'shared') {
        // Ensure the list of people is available before building the ledger
        await refreshSavedPeople();
        loadSharedLedger();
    } else if (tabId === 'detailedBreakdowns') {
        loadBreakdownView();
    }

    if (targetBtn) targetBtn.classList.add("active");
}

let breakdownChartRange = '6m'; // Default chart range

function setBreakdownChartRange(event, range) {
    breakdownChartRange = range;
    // Update active button styling
    document.querySelectorAll('.chart-time-controls .time-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.currentTarget.classList.add('active');
    loadBreakdownData(); // Reload the data with the new range
}

/** DETAILED BREAKDOWNS LOGIC **/
async function loadBreakdownView() {
    const yearSel = document.getElementById('breakdownYear');
    const monthSel = document.getElementById('breakdownMonth');
    
    // Initialize Year Dropdown if empty
    if (!yearSel.value) {
        setupYearDropdown();
        yearSel.value = new Date().getFullYear();
    }
    
    // Populate/update Month Dropdown to limit months for the current year
    updateBreakdownMonthDropdown();

    // Load Tag Checklist — scoped to the selected category
    const selectedCategory = document.getElementById('breakdownCategory').value;
    const response = await fetch(`/api/tags${selectedCategory ? '?category=' + encodeURIComponent(selectedCategory) : ''}`);
    const tags = await response.json();
    const container = document.getElementById('tagCheckboxes');
    container.innerHTML = tags.map(t => `
        <label style="font-size: 0.9em; display: flex; align-items: center; gap: 8px; margin-bottom: 4px; cursor: pointer;">
            <input type="checkbox" class="breakdown-tag-check" value="${t.id}" onchange="loadBreakdownData()"> ${t.name}
        </label>
    `).join('');

    // Clear comparison selection when the category changes
    activeComparisonViews.clear();

    // Auto-load the saved default view for this category
    loadTagDefaults();
    loadSavedViews();
}

async function setBreakdownViewMode(mode) {
    currentViewMode = mode;
    document.getElementById('btnBreakdownGross').classList.toggle('active', mode === 'gross');
    document.getElementById('btnBreakdownNet').classList.toggle('active', mode === 'net');
    loadBreakdownData();
}

async function saveTagDefaults() {
    const category = document.getElementById('breakdownCategory').value;
    const selectedTags = Array.from(document.querySelectorAll('.breakdown-tag-check:checked')).map(i => i.value);
    
    await fetch('/api/tag-defaults', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ category, tag_ids: selectedTags })
    });
    alert(`Default tags saved for ${category}`);
}

async function loadTagDefaults() {
    const category = document.getElementById('breakdownCategory').value;
    const response = await fetch(`/api/tag-defaults?category=${category}`);
    const defaultIds = await response.json();

    const checks = document.querySelectorAll('.breakdown-tag-check');
    checks.forEach(c => {
        c.checked = defaultIds.includes(parseInt(c.value));
    });
    loadBreakdownData();
}

function deselectAllTags() {
    document.querySelectorAll('.breakdown-tag-check').forEach(c => c.checked = false);
    loadBreakdownData();
}

async function loadBreakdownData() {
    if (activeComparisonViews.size > 0) {
        await loadComparisonData();
        return;
    }

    const year = document.getElementById('breakdownYear').value;
    const month = document.getElementById('breakdownMonth').value;
    const category = document.getElementById('breakdownCategory').value;
    const tagIds = Array.from(document.querySelectorAll('.breakdown-tag-check:checked')).map(i => i.value);

    const tableBody = document.getElementById('breakdownTableBody');

    if (tagIds.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px; color: #888;">No tags selected. Select tags on the left to see data.</td></tr>';
        Plotly.purge('breakdownHistoryChart');
        return;
    }

    // Build URL with multiple tag_ids parameters
    let params = new URLSearchParams({ year, month, category, view_mode: currentViewMode, time_range: breakdownChartRange });
    tagIds.forEach(id => params.append('tag_ids', id));

    const response = await fetch(`/api/breakdown-report?${params.toString()}`);
    const data = await response.json();

    // Render Transaction List Table grouped by month
    let grandTotal = 0;
    if (data.table && data.table.length > 0) {
        // Group rows by YYYY-MM, preserving DESC order from the server
        const byMonth = {};
        const monthOrder = [];
        data.table.forEach(row => {
            const key = row.date.substring(0, 7);
            if (!byMonth[key]) { byMonth[key] = []; monthOrder.push(key); }
            byMonth[key].push(row);
        });

        let html = '';
        monthOrder.forEach(key => {
            const rows = byMonth[key];
            const [yr, mo] = key.split('-');
            const monthLabel = new Date(parseInt(yr), parseInt(mo) - 1, 1)
                .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            const monthTotal = rows.reduce((sum, r) => sum + r.display_amount, 0);
            grandTotal += monthTotal;

            // Month separator row
            html += `
                <tr style="border-top: 3px solid #2c3e50; background: #2c3e50;">
                    <td colspan="2" style="font-weight:700; padding:7px 10px; color:#fff; font-size:0.88em; letter-spacing:0.03em;">${monthLabel}</td>
                    <td style="text-align:right; font-weight:700; padding:7px 10px; color:#fff; white-space:nowrap;">$${monthTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                </tr>
            `;

            rows.forEach(row => {
                const catBadge = !category && row.category
                    ? `<span style="font-size:0.75em; font-weight:600; padding:1px 7px; border-radius:10px; background:var(--surface-2); color:var(--muted); margin-left:4px;">${row.category}</span>`
                    : '';
                html += `
                    <tr>
                        <td style="white-space: nowrap;">${formatDate(row.date)}</td>
                        <td>
                            <div style="font-weight: 600;">${row.description}${catBadge}</div>
                            ${renderTxnTags(row)}
                        </td>
                        <td style="text-align:right; font-weight:700; white-space: nowrap;">$${row.display_amount.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                    </tr>
                `;
            });
        });

        tableBody.innerHTML = html;
        tableBody.innerHTML += `
            <tfoot style="border-top: 2px solid #333; font-weight: bold; background: #f8f9fa;">
                <tr><td>TOTAL</td><td colspan="2" style="text-align:right;">$${grandTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}</td></tr>
            </tfoot>
        `;
    } else {
        tableBody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px; color: #888;">No transactions found for this period with the selected tags.</td></tr>';
    }

    // Render History Graph
    const x = data.graph.map(g => g.month);
    const y = data.graph.map(g => g.total);

    const average = y.length > 0 ? (y.reduce((sum, val) => sum + val, 0) / y.length) : 0;
    const avgY = Array(y.length).fill(average);

    const chartData = [
        {
            x: x, y: y,
            type: 'scatter', 
            mode: 'lines+markers',
            name: 'Spending',
            line: {color: '#34A77B', width: 3},
            fill: 'tozeroy', 
            fillcolor: 'rgba(52, 167, 123, 0.12)',
            hovertemplate: '<b>%{x}</b><br>$%{y:,.2f}<extra></extra>'
        },
        {
            x: x, y: avgY,
            type: 'scatter',
            mode: 'lines',
            name: `Average ($${average.toFixed(2)})`,
            line: {color: '#E87B61', width: 2, dash: 'dash'},
            hovertemplate: '<b>Average</b><br>$%{y:,.2f}<extra></extra>'
        }
    ];

    const mobile = isMobile();
    const layout = {
        ...(mobile ? {} : { title: { text: `Spending Trend: ${category}`, font: { size: 16, color: '#F3F4F5' } } }),
        font: { color: '#C9CDD3', family: 'Schibsted Grotesk, sans-serif' },
        xaxis: { title: mobile ? '' : 'Month', tickfont: { color: '#A2A7B0', size: mobile ? 9 : 11 }, tickangle: mobile ? -55 : 0, gridcolor: 'rgba(0,0,0,0)', linecolor: '#565C66' },
        yaxis: { title: mobile ? '' : 'Total Spend ($)', tickprefix: '$', tickfont: { color: '#A2A7B0', size: mobile ? 9 : 11 }, gridcolor: '#4D535D', zerolinecolor: '#565C66' },
        margin: chartMargins(mobile ? {} : { t: 60 }),
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: mobile ? -0.4 : -0.2, font: { color: '#C9CDD3', size: mobile ? 10 : 12 } }
    };

    Plotly.newPlot('breakdownHistoryChart', chartData, layout, {responsive: true, displayModeBar: false});
}

/** TAG MODAL LOGIC **/
let stagedTags = new Set(); // tags selected but not yet submitted

async function openTagModal() {
    const checked = document.querySelectorAll('.expense-check:checked, .payment-check:checked');
    if (checked.length === 0) return alert("Select at least one transaction first.");

    stagedTags.clear();
    document.getElementById('newTagName').value = '';
    renderStagedTags();

    const response = await fetch('/api/tags');
    const tags = await response.json();
    renderExistingTags(tags);

    document.getElementById('tagModalSub').textContent = `Adding tag(s) to ${checked.length} selected item(s)`;
    document.getElementById('tagModal').style.display = 'block';
}

function _escJs(s) { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function renderExistingTags(tags) {
    const container = document.getElementById('existingTagsContainer');
    container.innerHTML = tags.map(t => `
        <div id="tag-pill-${t.id}" style="display:inline-flex; align-items:center; margin:4px; background:#f8f9fa; border:1px solid #ddd; border-radius:4px; padding:4px 8px; font-size:0.85em; cursor:pointer;"
             onclick="toggleStagedTag('${_escJs(t.name)}', ${t.id})">
            <span style="font-weight:600; color:#333; margin-right:8px;">${t.name}</span>
            <button type="button" onclick="event.stopPropagation(); deleteTagGlobal(${t.id}, '${_escJs(t.name)}')" style="background:none; border:none; color:#e74c3c; cursor:pointer; font-weight:bold; font-size:1.1em; line-height:1; padding:0 2px;">×</button>
        </div>
    `).join('');
}

function toggleStagedTag(name, id) {
    if (stagedTags.has(name)) {
        stagedTags.delete(name);
    } else {
        stagedTags.add(name);
    }
    renderStagedTags();
    // Highlight the pill to show it's selected
    const pill = document.getElementById(`tag-pill-${id}`);
    if (pill) {
        pill.style.background = stagedTags.has(name) ? '#e0d0f5' : '#f8f9fa';
        pill.style.borderColor = stagedTags.has(name) ? '#8e44ad' : '#ddd';
    }
}

function stageNewTag() {
    const name = document.getElementById('newTagName').value.trim();
    if (!name) return;
    stagedTags.add(name);
    document.getElementById('newTagName').value = '';
    renderStagedTags();
}

function renderStagedTags() {
    const container = document.getElementById('stagedTagsContainer');
    if (!stagedTags.size) {
        container.innerHTML = '<span style="font-size:0.8em; color:#bbb; font-style:italic;">No tags staged yet</span>';
        return;
    }
    container.innerHTML = Array.from(stagedTags).map(name => `
        <span style="display:inline-flex; align-items:center; background:#e0d0f5; border:1px solid #8e44ad; border-radius:4px; padding:3px 8px; font-size:0.85em; font-weight:600; color:#6c2a8a;">
            ${name}
            <button type="button" onclick="removeStagedTag('${_escJs(name)}')" style="background:none; border:none; color:#8e44ad; cursor:pointer; font-weight:bold; font-size:1.1em; line-height:1; padding:0 0 0 6px;">×</button>
        </span>
    `).join('');
}

function removeStagedTag(name) {
    stagedTags.delete(name);
    renderStagedTags();
    // Un-highlight the corresponding existing tag pill if present
    document.querySelectorAll('#existingTagsContainer [id^="tag-pill-"]').forEach(pill => {
        if (pill.querySelector('span').textContent.trim() === name) {
            pill.style.background = '#f8f9fa';
            pill.style.borderColor = '#ddd';
        }
    });
}

async function deleteTagGlobal(tagId, tagName) {
    if (!confirm(`Are you sure you want to delete the tag "${tagName}" globally? This will remove it from all transactions and defaults.`)) return;

    try {
        const response = await fetch(`/api/tag/${tagId}`, { method: 'DELETE' });
        if (response.ok) {
            stagedTags.delete(tagName);
            renderStagedTags();
            const responseTags = await fetch('/api/tags');
            renderExistingTags(await responseTags.json());
            await loadFullTransactions();
            if (document.getElementById('shared').classList.contains('active')) loadSharedLedger();
            if (document.getElementById('detailedBreakdowns').classList.contains('active')) loadBreakdownView();
        } else {
            alert('Failed to delete tag');
        }
    } catch (e) {
        console.error(e);
        alert('Network error deleting tag');
    }
}

function closeTagModal() {
    document.getElementById('tagModal').style.display = 'none';
    document.getElementById('newTagName').value = '';
    stagedTags.clear();
    renderStagedTags();
}

async function submitTags() {
    // Also stage anything typed but not yet staged
    const typedName = document.getElementById('newTagName').value.trim();
    if (typedName) stagedTags.add(typedName);

    if (!stagedTags.size) return alert("Please select or enter at least one tag.");

    const checked = document.querySelectorAll('.expense-check:checked, .payment-check:checked');
    const ids = Array.from(checked).map(c => c.value);

    // Submit each staged tag in parallel
    const results = await Promise.all(Array.from(stagedTags).map(tagName =>
        fetch('/api/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, tag_name: tagName })
        })
    ));

    if (results.every(r => r.ok)) {
        closeTagModal();
        await loadFullTransactions();
        if (document.getElementById('shared').classList.contains('active')) loadSharedLedger();
        if (document.getElementById('detailedBreakdowns').classList.contains('active')) loadBreakdownView();
    } else {
        alert("One or more tags failed to save.");
    }
}

function setupYearDropdown() {
    // Only target the dropdowns that actually exist in your HTML
    const yearSelectIds = ['yearSelect', 'filterYear', 'breakdownYear'];
    
    const startYear = 2026; 
    const currentYear = new Date().getFullYear();
    const endYear = Math.max(startYear, currentYear);

    yearSelectIds.forEach(id => {
        const select = document.getElementById(id);
        if (!select) return; // Skip if ID is missing

        select.innerHTML = '';

        // For the Transactions filter, we want an "All Years" option
        if (id === 'filterYear') {
            const allOption = document.createElement('option');
            allOption.value = "";
            allOption.text = "All Years";
            select.appendChild(allOption);
        }

        // Add 2026, 2027, etc.
        for (let year = endYear; year >= startYear; year--) {
            const option = document.createElement('option');
            option.value = year;
            option.text = year;
            select.appendChild(option);
        }
    });
}

async function updateTagsDropdown() {
    const tagSelect = document.getElementById('filterTag');
    if (!tagSelect) return;

    try {
        const response = await fetch('/api/tags');
        const tags = await response.json();
        
        const selectedValue = tagSelect.value;
        
        tagSelect.innerHTML = '<option value="">All Tags</option><option value="__none__">No Tags</option>';
        tags.forEach(t => {
            const option = document.createElement('option');
            option.value = t.name;
            option.text = t.name;
            tagSelect.appendChild(option);
        });
        
        tagSelect.value = selectedValue;
    } catch (e) {
        console.error("Error updating tags dropdown:", e);
    }
}

async function loadFullTransactions() {
    const response = await fetch('/api/transactions?limit=5000');
    allTransactions = await response.json();
    updateBankCategoryDropdown(); // Update bank category dropdown based on loaded transactions
    updateBankNameDropdown(); // Update bank name dropdown based on loaded transactions
    await updateTagsDropdown();
    filterTransactions(); // Initial draw
}

function filterTransactions() {
    const search = document.getElementById('filterSearch').value.toLowerCase();
    const searchAmount = search.replace(/[$,]/g, ''); // Remove symbols for amount matching
    const ruleCat = document.getElementById('filterCategory').value;
    const bankCat = document.getElementById('filterBankCategory').value;
    const bankName = document.getElementById('filterBankName').value;
    const sharedFilter = document.getElementById('filterShared').value; // NEW
    const tagFilter = document.getElementById('filterTag').value; // NEW
    const year = document.getElementById('filterYear').value;
    const month = document.getElementById('filterMonth').value;

    // 1. Check if ANY filter is active
    // We assume an active filter is anything other than the default "All" or empty string
    // Only count it as "active" if it's NOT just the year being selected
    const isFilterActive = (search !== "" || ruleCat !== "" || bankCat !== "" || 
                            bankName !== "" || sharedFilter !== "" || tagFilter !== "" || month !== "");

    const filtered = allTransactions.filter(txn => {
        const [y, m, d] = txn.date.split('-');
        const matchesDesc = txn.description.toLowerCase().includes(search);
        const matchesAmt = searchAmount !== "" && Math.abs(txn.amount).toFixed(2).includes(searchAmount);
        const matchesSearch = matchesDesc || matchesAmt;
        const matchesRuleCat = ruleCat === "" ||
                              (ruleCat === "__uncategorized__" ? (!txn.category || txn.category === '') : txn.category === ruleCat);
        const matchesBankCat = bankCat === "" || txn.bank_category === bankCat;
        const matchesBankName = bankName === "" || txn.card_name === bankName;
        const matchesShared = sharedFilter === "" || 
                              (sharedFilter === "1" && txn.is_shared == 1) || 
                              (sharedFilter === "0" && txn.is_shared == 0);
        const matchesTag = tagFilter === "" || 
                          (tagFilter === "__none__" ? (!txn.tags || txn.tags.length === 0) : (txn.tags && txn.tags.some(t => t.name === tagFilter)));
        const matchesYear = year === "" || y === year;
        const matchesMonth = month === "" || m === month;

        return matchesSearch && matchesRuleCat && matchesBankCat && matchesBankName && matchesShared && matchesTag && matchesYear && matchesMonth;
    });

    // 2. Handle the Totals Display
    const expTotalCont = document.getElementById('expenseTotalContainer');
    const payTotalCont = document.getElementById('paymentTotalContainer');

    if (isFilterActive) {
        // Calculate Expenses Total
        const expenseSum = filtered
            .filter(t => !t.is_payment)
            .reduce((sum, t) => sum + Math.abs(t.amount), 0);
        
        // Calculate Payments Total
        const paymentSum = filtered
            .filter(t => t.is_payment)
            .reduce((sum, t) => sum + Math.abs(t.amount), 0);

        document.getElementById('expenseTotalValue').textContent = `$${expenseSum.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        document.getElementById('paymentTotalValue').textContent = `$${paymentSum.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        
        expTotalCont.style.display = 'block';
        payTotalCont.style.display = 'block';
    } else {
        // No filters? Hide the totals
        expTotalCont.style.display = 'none';
        payTotalCont.style.display = 'none';
    }

    renderFilteredTable(filtered);
}

// Debounced version used by the search box oninput — avoids re-filtering on every keystroke
const filterTransactionsDebounced = debounce(filterTransactions, 150);

function isMobile() { return window.innerWidth <= 768; }

function debounce(fn, ms) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

function chartMargins(overrides = {}) {
    const base = isMobile()
        ? { t: 10, b: 55, l: 42, r: 10 }
        : { t: 20, b: 80, l: 60, r: 20 };
    return { ...base, ...overrides };
}

let _lastTransactionData = null;

function renderCardView(txns, listId, isPayment) {
    const list = document.getElementById(listId);
    if (!list) return;
    const checkClass = isPayment ? 'payment-check' : 'expense-check';
    if (txns.length === 0) {
        list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--muted);">No ${isPayment ? 'payments' : 'expenses'} found</div>`;
        return;
    }
    list.innerHTML = txns.map(txn => {
        const appliedBadge = txn.applied_date
            ? `<span class="txn-card-applied">→ ${fmtAppliedDate(txn.applied_date)}</span>` : '';
        const sharedBadge = txn.is_shared == 1
            ? `<span class="txn-card-shared">Shared</span>` : '';
        const tagPills = (txn.tags || []).map(t =>
            `<span class="transaction-tag" style="font-size:0.75em;padding:2px 7px;">${t.name}</span>`
        ).join('');
        const amtStyle = isPayment ? 'color:#27ae60' : 'color:var(--text)';
        const amtPrefix = isPayment ? '+' : '';
        return `
        <div class="txn-card" onclick="openEditSingle(${txn.id},${isPayment})">
            <div class="txn-card-top">
                <input type="checkbox" class="${checkClass}" value="${txn.id}"
                       onclick="event.stopPropagation()"
                       style="width:18px;height:18px;flex-shrink:0;cursor:pointer;min-height:unset;">
                <div class="txn-card-info">
                    <span class="txn-card-date">${formatDate(txn.date)}${appliedBadge}</span>
                    <span class="txn-card-desc">${txn.description}</span>
                </div>
                <span class="txn-card-amount" style="${amtStyle}">${amtPrefix}$${Math.abs(txn.amount).toFixed(2)}</span>
            </div>
            <div class="txn-card-bottom">
                <span class="tag-user">${txn.category}</span>
                <span class="${getAccountClass(txn.card_name)}">${txn.card_name || 'Unknown'}</span>
                ${sharedBadge}${tagPills}
            </div>
        </div>`;
    }).join('');
}

function openEditSingle(id, isPayment) {
    document.querySelectorAll('.expense-check, .payment-check').forEach(c => { c.checked = false; });
    const cls = isPayment ? '.payment-check' : '.expense-check';
    const box = document.querySelector(`${cls}[value="${id}"]`);
    if (box) box.checked = true;
    openEditModal();
}

function renderFilteredTable(data) {
    _lastTransactionData = data;

    const expenseTableWrap = document.getElementById('expenseTableWrap');
    const paymentTableWrap = document.getElementById('paymentTableWrap');
    const expenseCardList  = document.getElementById('expenseCardList');
    const paymentCardList  = document.getElementById('paymentCardList');

    const expenses = data.filter(txn => txn.is_payment == 0 || txn.is_payment === false);
    const payments = data.filter(txn => txn.is_payment == 1 || txn.is_payment === true);

    if (isMobile()) {
        if (expenseTableWrap) expenseTableWrap.style.display = 'none';
        if (paymentTableWrap) paymentTableWrap.style.display = 'none';
        if (expenseCardList)  { expenseCardList.style.display = 'block'; renderCardView(expenses, 'expenseCardList', false); }
        if (paymentCardList)  { paymentCardList.style.display = 'block'; renderCardView(payments, 'paymentCardList', true); }
        return;
    }

    // Desktop: tables
    if (expenseTableWrap) expenseTableWrap.style.display = '';
    if (paymentTableWrap) paymentTableWrap.style.display = '';
    if (expenseCardList)  expenseCardList.style.display = 'none';
    if (paymentCardList)  paymentCardList.style.display = 'none';

    const expenseBody = document.getElementById('fullTransactionsBody');
    const paymentBody = document.getElementById('paymentsBody');

    if (expenses.length === 0) {
        expenseBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No expenses found</td></tr>';
    } else {
        expenseBody.innerHTML = expenses.map(txn => `
            <tr>
                <td><input type="checkbox" class="expense-check" value="${txn.id}"></td>
                <td>
                    ${formatDate(txn.date)}
                    ${txn.applied_date ? `<div style="font-size:0.75em;color:#e67e22;margin-top:2px;">→ ${fmtAppliedDate(txn.applied_date)}</div>` : ''}
                </td>
                <td>
                    <div style="font-weight:600;">${txn.description}</div>
                    <div style="font-size:0.85em; color:#666;">${txn.merchant || ''}</div>
                    ${renderTxnTags(txn)}
                </td>
                <td><span class="tag-user">${txn.category}</span></td>
                <td><span class="tag-bank">${txn.bank_category || ''}</span></td>
                <td><span class="${getAccountClass(txn.card_name)}">${txn.card_name || 'Unknown'}</span></td>
                <td style="text-align: center;">${txn.is_shared == 1 ? '✓' : ''}</td>
                <td style="font-weight:700;">$${Math.abs(txn.amount).toFixed(2)}</td>
            </tr>`
        ).join('');
    }

    if (paymentBody) {
        if (payments.length === 0) {
            paymentBody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No payments found</td></tr>';
        } else {
            paymentBody.innerHTML = payments.map(txn => `
                <tr style="background-color: #f0fff4;">
                    <td><input type="checkbox" class="payment-check" value="${txn.id}"></td>
                    <td>
                        ${formatDate(txn.date)}
                        ${txn.applied_date ? `<div style="font-size:0.75em;color:#e67e22;margin-top:2px;">→ ${fmtAppliedDate(txn.applied_date)}</div>` : ''}
                    </td>
                    <td>
                        <div style="font-weight:600;">${txn.description}</div>
                        <div style="font-size:0.85em; color:#666;">${txn.merchant || ''}</div>
                        ${renderTxnTags(txn)}
                    </td>
                    <td>${txn.category || ''}</td>
                    <td>${txn.bank_category || ''}</td>
                    <td><span class="${getAccountClass(txn.card_name)}">${txn.card_name}</span></td>
                    <td style="text-align: center;">${txn.is_shared == 1 ? '✓' : ''}</td>
                    <td style="color: #27ae60; font-weight:700;">+$${Math.abs(txn.amount).toFixed(2)}</td>
                </tr>`
            ).join('');
        }
    }
}

//async function deleteRule(ruleId) {
//    if (!confirm('Are you sure you want to delete this rule?')) return;
//
//    try {
//        const response = await fetch(`/api/rules/${ruleId}`, {
//            method: 'DELETE'
//        });
//        
//        if (response.ok) {
//            loadRules(); // Refresh the list
//        } else {
//            alert('Failed to delete rule');
//        }
//    } catch (error) {
//        console.error('Error:', error);
//    }
//}

async function togglePayment(txnId) {
    try {
        const response = await fetch(`/api/transaction/${txnId}/toggle-payment`, {
            method: 'POST'
        });
        
        if (response.ok) {
            // Success! Reload the data
            loadFullTransactions();
            loadSummary(true);
        } else {
            // This is where your error is currently triggering
            const errorData = await response.json();
            console.error("Server Error:", errorData);
            alert('Failed to move transaction');
        }
    } catch (error) {
        console.error('Network Error:', error);
    }
}

function updateBankCategoryDropdown() {
    const bankSelect = document.getElementById('filterBankCategory');
    if (!bankSelect) return;

    // 1. Get all unique bank categories from the current transaction list
    const categories = [...new Set(allTransactions.map(txn => txn.bank_category))]
        .filter(cat => cat && cat !== '') // Remove nulls or empties
        .sort();

    // 2. Clear and rebuild the dropdown
    bankSelect.innerHTML = '<option value="">All Bank Categories</option>';
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.text = cat;
        bankSelect.appendChild(option);
    });
}

// Toggle the custom bank input field
function toggleCustomBank() {
    const select = document.getElementById('bankSelect');
    const wrapper = document.getElementById('customBankWrapper');
    wrapper.style.display = (select.value === 'Other') ? 'block' : 'none';
}

// Update the dynamic Bank Name filter (similar to how we did category)
function updateBankNameDropdown() {
    const bankSelect = document.getElementById('filterBankName');
    if (!bankSelect || !allTransactions) return;

    // Get unique card names, filter out nulls/blanks, and sort
    const names = [...new Set(allTransactions.map(txn => txn.card_name))]
        .filter(name => name && name.trim() !== '')
        .sort();

    bankSelect.innerHTML = '<option value="">All Accounts</option>';
    names.forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.text = name;
        bankSelect.appendChild(option);
    });
}

function openAddModal() {
    isModalPaymentMode = document.getElementById('addType').value === 'payment';
    document.getElementById('addDate').valueAsDate = new Date();
    document.getElementById('addDesc').value = '';
    document.getElementById('addAmount').value = '';
    document.getElementById('addSharedStatus').value = 'personal';
    document.getElementById('addSharedFields').style.display = 'none';
    document.getElementById('addShareRowsContainer').innerHTML = '';
    document.getElementById('addCustomBankName').style.display = 'none';
    document.getElementById('addAccount').selectedIndex = 0;

    updateAddCategoryOptions();
    
    // Rebuild Payer Dropdown for add modal
    const payerSelect = document.getElementById('addPayer');
    payerSelect.innerHTML = `<option value="Me">I</option>`;
    savedPeople.filter(p => p !== 'Me').forEach(p => {
        payerSelect.innerHTML += `<option value="${p}">${p}</option>`;
    });
    payerSelect.innerHTML += `<option value="Other">Other...</option>`;
    document.getElementById('addPayerCustom').style.display = 'none';

    document.getElementById('addModal').style.display = 'block';
}

function closeAddModal() {
    document.getElementById('addModal').style.display = 'none';
}

function toggleTxnSection(section) {
    const collapsible = document.getElementById(section + 'Collapsible');
    const chevron     = document.getElementById(section + 'Chevron');
    if (!collapsible) return;
    const isHidden = collapsible.style.display === 'none';
    collapsible.style.display = isHidden ? '' : 'none';
    if (chevron) chevron.textContent = isHidden ? '▼' : '▶';
}

function toggleBreakdownSidebar() {
    const sidebar = document.querySelector('.breakdown-sidebar');
    const btn = document.getElementById('breakdownSidebarToggle');
    if (!sidebar || !btn) return;
    const isOpen = sidebar.classList.toggle('sidebar-open');
    btn.textContent = isOpen ? '▲ Hide Filters & Views' : '▼ Filters & Views';
}

function toggleAddSharedFields() {
    const status = document.getElementById('addSharedStatus').value;
    const fields = document.getElementById('addSharedFields');
    const container = document.getElementById('addShareRowsContainer');
    fields.style.display = (status === 'shared') ? 'flex' : 'none';
    if (status === 'shared' && container.children.length === 0) {
        updateSharedSentence('add');
    }
}

function updateAddCategoryOptions() {
    const type = document.getElementById('addType').value;
    isModalPaymentMode = (type === 'payment');
    const catSelect = document.getElementById('addCategory');
    const list = (type === 'payment') ? PAYMENT_CATEGORIES : TRACKED_CATEGORIES;
    catSelect.innerHTML = '';
    list.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat; option.text = cat;
        catSelect.appendChild(option);
    });
    
    if (document.getElementById('addSharedStatus').value === 'shared') {
        updateSharedSentence('add');
    }
}

function toggleAddCustomBank() {
    const select = document.getElementById('addAccount');
    const input = document.getElementById('addCustomBankName');
    input.style.display = (select.value === 'Other') ? 'block' : 'none';
}

async function submitAdd() {
    const status = document.getElementById('addSharedStatus').value;
    const type = document.getElementById('addType').value;
    const accountSelect = document.getElementById('addAccount');
    const customAccount = document.getElementById('addCustomBankName').value;

    const payload = {
        date: document.getElementById('addDate').value,
        description: document.getElementById('addDesc').value,
        amount: parseFloat(document.getElementById('addAmount').value) || 0,
        category: document.getElementById('addCategory').value,
        account: accountSelect.value === 'Other' ? customAccount : accountSelect.value,
        is_payment: type === 'payment' ? 1 : 0,
        is_shared: status === 'shared' ? 1 : 0
    };

    if (status === 'shared') {
        const pSelect = document.getElementById('addPayer');
        const pCustom = document.getElementById('addPayerCustom');
        payload.payer = (pSelect.value === 'Other') ? pCustom.value : pSelect.value;

        if (isModalPaymentMode) {
            const amt = document.getElementById('addPaymentAmount').value;
            // If they paid you, the 'share' of that payment belongs to "Me"
            payload.shares = [{ name: 'Me', amount: parseFloat(amt) || 0 }];
        } else {
            const shareRows = document.querySelectorAll('#addShareRowsContainer .share-row');
            payload.shares = Array.from(shareRows).map(row => {
                const s = row.querySelector('.share-name-select');
                const c = row.querySelector('.share-name-custom');
                const a = row.querySelector('.share-amount-input');
                return {
                    name: (s.value === 'Other') ? c.value : s.value,
                    amount: parseFloat(a.value) || 0
                };
            });
        }
    }

    const response = await fetch('/api/transaction/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (response.ok) {
        closeAddModal();
        await loadFullTransactions();
        loadSummary(true);
        refreshSavedPeople();
    } else {
        alert("Failed to save transaction.");
    }
}

// Function to select/deselect all checkboxes in a table
function toggleAll(type) {
    const master = document.getElementById(type === 'expenses' ? 'selectAllExpenses' : 'selectAllPayments');
    const checks = document.querySelectorAll(type === 'expenses' ? '.expense-check' : '.payment-check');
    checks.forEach(c => c.checked = master.checked);
}

// Bulk Move (Invert is_payment)
async function bulkTogglePayment() {
    const checked = document.querySelectorAll('.expense-check:checked, .payment-check:checked');
    if (checked.length === 0) return alert("Select at least one transaction.");

    if (!confirm(`Move ${checked.length} transactions?`)) return;

    for (let check of checked) {
        await fetch(`/api/transaction/${check.value}/toggle-payment`, { method: 'POST' });
    }
    
    await loadFullTransactions();
    loadSummary(true);
}

// Bulk Delete
async function bulkDelete() {
    const checked = document.querySelectorAll('.expense-check:checked, .payment-check:checked');
    if (checked.length === 0) return alert("Select at least one transaction.");

    const selectedIds = Array.from(checked).map(c => parseInt(c.value));
    const hasSettlements = allTransactions.some(t => selectedIds.includes(t.id) && t.settlement_count > 0);

    let msg = `Delete ${checked.length} transactions permanently?`;
    if (hasSettlements) {
        msg = `Warning: One or more selected transactions are involved in settlements. Deleting them will remove associated history and reset balances. Proceed?`;
    }

    if (!confirm(msg)) return;

    for (let check of checked) {
        await fetch(`/api/transaction/${check.value}`, { method: 'DELETE' });
    }
    
    await loadFullTransactions();
    loadSummary(true);
}

async function openEditModal() {
    const checked = document.querySelectorAll('.expense-check:checked, .payment-check:checked');
    const ids = Array.from(checked).map(c => c.value);

    if (ids.length === 0) return alert("Select at least one transaction.");

    const isPaymentEdit = document.querySelectorAll('.payment-check:checked').length > 0;
    isModalPaymentMode = isPaymentEdit;
    
    // 1. Initial Reset
    _currentEditAmount = null;
    document.getElementById('shareRowsContainer').innerHTML = '';
    document.getElementById('editDesc').value = '';
    document.getElementById('editSharedStatus').value = 'no_change';
    document.getElementById('sharedFields').style.display = 'none';
    document.getElementById('editAppliedDate').value = '';
    document.getElementById('editPaymentAmount').value = '';
    document.getElementById('splitRowsContainer').innerHTML = '';
    document.getElementById('appliedDateSection').style.display = 'none';
    document.getElementById('paymentSplitsSection').style.display = 'none';

    // 2. Rebuild Dropdowns for edit modal
    if (typeof setupModalDropdowns === 'function') {
        setupModalDropdowns(isPaymentEdit);
    }

    // 3. POPULATE DATA (Only if exactly 1 transaction is selected)
    if (ids.length === 1) {
        const response = await fetch(`/api/transaction/${ids[0]}/details`);
        const txn = await response.json();
        _currentEditAmount = Math.abs(parseFloat(txn.amount) || 0);

        // Show applied date section and pre-fill if set
        document.getElementById('appliedDateSection').style.display = 'block';
        if (txn.applied_date) {
            document.getElementById('editAppliedDate').value = txn.applied_date;
        }

        // Show payment splits section for payment transactions
        if (txn.is_payment) {
            document.getElementById('paymentSplitsSection').style.display = 'block';
            if (txn.payment_splits && txn.payment_splits.length > 0) {
                txn.payment_splits.forEach(s => addSplitRow(s.applied_date, s.amount, s.note || ''));
            }
        }

        // Fill Description and Category
        document.getElementById('editDesc').value = txn.description || '';
        document.getElementById('editCategory').value = txn.category || '';

        // Handle Shared Status
        if (txn.is_shared) {
            document.getElementById('editSharedStatus').value = 'shared';
            document.getElementById('sharedFields').style.display = 'flex';
            
            // Force the sentence UI to update based on the shared status and type
            updateSharedSentence('edit');

            // Set the Payer (Who swiped the card)
            const payerSelect = document.getElementById('editPayer');
            if (payerSelect) {
                if ([...payerSelect.options].some(opt => opt.value === txn.payer)) {
                    payerSelect.value = txn.payer;
                } else {
                    payerSelect.value = 'Other';
                    const pCustom = document.getElementById('editPayerCustom');
                    pCustom.value = txn.payer;
                    pCustom.style.display = 'block';
                }
            }

            // Populate the specific shares (Nicole, Matt, Lori, etc.)
            if (txn.shares && txn.shares.length > 0) {
            if (isModalPaymentMode) {
                const share = txn.shares[0];
                document.getElementById('editPaymentAmount').value = share.share_amount;
            } else {
                txn.shares.forEach(s => addShareRow('shareRowsContainer', s.person_name, s.share_amount));
            }
            }
        } else {
            document.getElementById('editSharedStatus').value = 'personal';
            const payerSelect = document.getElementById('editPayer');
            if (payerSelect) payerSelect.value = 'Me';
        }
    } else {
        // If Bulk Editing (>1 selected), default to 'Me' and prep a blank row
        const payerSelect = document.getElementById('editPayer');
        if (payerSelect) payerSelect.value = 'Me';
    }

    document.getElementById('editModalSub').textContent = `Editing ${ids.length} item(s)`;
    document.getElementById('editModal').style.display = 'block';
}


// Add this helper to your openEditModal or anywhere in main.js
function toggleEditSharedFields() {
    const status = document.getElementById('editSharedStatus').value;
    const fields = document.getElementById('sharedFields');
    const container = document.getElementById('shareRowsContainer');

    fields.style.display = (status === 'shared') ? 'flex' : 'none';

    if (status === 'shared') {
        updateSharedSentence('edit');
    }
}

function closeEditModal() {
    document.getElementById('editModal').style.display = 'none';
    document.getElementById('editDesc').value = '';
}

async function submitEdit() {
    const status = document.getElementById('editSharedStatus').value;
    const checked = document.querySelectorAll('.expense-check:checked, .payment-check:checked');
    const ids = Array.from(checked).map(c => c.value);
    
    const payload = {
        ids,
        description: document.getElementById('editDesc').value,
        category: document.getElementById('editCategory').value,
        status
    };

    // Include applied_date and payment_splits only for single-transaction edits
    if (ids.length === 1) {
        payload.applied_date = document.getElementById('editAppliedDate').value || null;

        const splitsSection = document.getElementById('paymentSplitsSection');
        if (splitsSection.style.display !== 'none') {
            payload.payment_splits = Array.from(
                document.querySelectorAll('#splitRowsContainer .split-row')
            ).map(row => ({
                date:   row.querySelector('.split-date').value,
                amount: parseFloat(row.querySelector('.split-amount').value) || 0,
                note:   row.querySelector('.split-note').value
            })).filter(s => s.date && s.amount > 0);
        }
    }

    if (status === 'shared') {
        payload.is_shared = 1;
        const pSelect = document.getElementById('editPayer');
        const pCustom = document.getElementById('editPayerCustom');
        payload.payer = (pSelect.value === 'Other') ? pCustom.value : pSelect.value;

        if (isModalPaymentMode) {
            const amt = document.getElementById('editPaymentAmount').value;
            // Payment received: the person who paid is the Payer, the share is "Me"
            payload.shares = [{ name: 'Me', amount: parseFloat(amt) || 0 }];
        } else {
            const shareRows = document.querySelectorAll('#shareRowsContainer .share-row');
            payload.shares = Array.from(shareRows).map(row => {
                const s = row.querySelector('.share-name-select');
                const c = row.querySelector('.share-name-custom');
                const a = row.querySelector('.share-amount-input');
                return {
                    name: (s.value === 'Other') ? c.value : s.value,
                    amount: parseFloat(a.value) || 0
                };
            });
        }
    } else if (status === 'personal') {
        payload.is_shared = 0;
    }

    const response = await fetch('/api/transaction/bulk-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (response.ok) {
        closeEditModal();
        await loadFullTransactions();
        loadSummary(true);
        refreshSavedPeople();
    }
}

function updateManualCategoryOptions() {
    const type = document.getElementById('manualType').value;
    const catSelect = document.getElementById('manualCategory');
    const list = (type === 'payment') ? PAYMENT_CATEGORIES : TRACKED_CATEGORIES;
    
    catSelect.innerHTML = '';
    list.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.text = cat;
        catSelect.appendChild(option);
    });
}

// And update saveManualTransaction to send the is_payment flag
// txnData.is_payment = (document.getElementById('manualType').value === 'payment') ? 1 : 0;


function toggleManualCustomBank() {
    const select = document.getElementById('manualAccount');
    const wrapper = document.getElementById('manualCustomBankWrapper');
    if (select.value === 'Other') {
        wrapper.style.display = 'block';
    } else {
        wrapper.style.display = 'none';
        document.getElementById('manualCustomBankName').value = '';
    }
}

function getAccountClass(accountName) {
    if (!accountName) return 'tag-account tag-other';
    
    const name = accountName.toLowerCase();
    if (name.includes('chase')) return 'tag-account tag-chase';
    if (name.includes('capital')) return 'tag-account tag-capone';
    if (name.includes('venmo')) return 'tag-account tag-venmo';
    
    return 'tag-account tag-other';
}

async function loadAccountBreakdown() {
    const yearSelect = document.getElementById('yearSelect');
    const monthSelect = document.getElementById('monthSelect');
    if (!yearSelect || !monthSelect || !yearSelect.value) return;
    const year = yearSelect.value;
    const month = monthSelect.value;
    const params = new URLSearchParams({ year, month, view_mode: currentViewMode });
    try {
        const res = await fetch(`/api/account-breakdown?${params}`);
        const data = await res.json();
        const accounts = data.accounts || [];
        const container = document.getElementById('accountBreakdownTable');
        const totalEl = document.getElementById('accountTotalVal');
        if (!container) return;
        const grandTotal = accounts.reduce((s, a) => s + a.total, 0);
        const maxTotal = Math.max(...accounts.map(a => a.total), 1);
        const ACCT_COLORS = ['#34A77B','#5B9BD5','#D2A859','#9B7BD0','#E0795F','#4FB6A8','#D27FB0','#8FB04F'];
        container.innerHTML = accounts.map((a, i) => {
            const pct = grandTotal > 0 ? (a.total / grandTotal * 100) : 0;
            const barPct = maxTotal > 0 ? (a.total / maxTotal * 100) : 0;
            const amtStr = a.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            return `
                <div class="cat-row">
                    <div class="cat-name">${a.name || 'Unknown'}</div>
                    <div class="cat-track"><div class="cat-fill" style="width:${barPct.toFixed(1)}%; background:${ACCT_COLORS[i % ACCT_COLORS.length]};"></div></div>
                    <div class="cat-amount">$${amtStr}</div>
                    <div class="cat-pct">${Math.round(pct)}%</div>
                </div>
            `;
        }).join('') || '<div class="loading">No data for this period</div>';
        if (totalEl) {
            totalEl.textContent = '$' + grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
    } catch (e) {
        console.error('loadAccountBreakdown failed:', e);
    }
}

function setViewMode(mode) {
    currentViewMode = mode;
    
    // Update button styling
    const btnGross = document.getElementById('btnGross');
    const btnNet = document.getElementById('btnNet');
    if (btnGross) btnGross.classList.toggle('active', mode === 'gross');
    if (btnNet) btnNet.classList.toggle('active', mode === 'net');
    
    // Refresh everything
    loadSummary();
    loadAccountBreakdown();
}

function clearSharedFilters() {
    document.getElementById('sharedYearFilter').value = '';
    document.getElementById('sharedMonthFilter').value = '';
    loadSharedLedger();
}

let _sharedLedgerPromise = null; // { key, promise } — deduplicates prefetch and on-demand fetch

function _prefetchSharedLedger() {
    const key = 'person=&year=&month=';
    if (_sharedLedgerPromise && _sharedLedgerPromise.key === key) return;
    _sharedLedgerPromise = { key, promise: fetch(`/api/shared-ledger?${key}`).then(r => r.json()) };
}

async function loadSharedLedger() {
    // Populate year dropdown once (idempotent)
    const yearSel = document.getElementById('sharedYearFilter');
    if (yearSel.options.length <= 1) {
        const curYear = new Date().getFullYear();
        for (let y = curYear - 2; y <= curYear; y++) {
            const opt = document.createElement('option');
            opt.value = y; opt.text = y;
            yearSel.appendChild(opt);
        }
    }

    try {
        const person = document.getElementById('sharedPersonFilter').value;
        const year   = document.getElementById('sharedYearFilter').value;
        const month  = document.getElementById('sharedMonthFilter').value;
        const key    = new URLSearchParams({ person, year, month }).toString();

        if (!_sharedLedgerPromise || _sharedLedgerPromise.key !== key) {
            _sharedLedgerPromise = { key, promise: fetch(`/api/shared-ledger?${key}`).then(r => r.json()) };
        }
        const data = await _sharedLedgerPromise.promise;

        // 1. Update Person Dropdown
        const personSelect = document.getElementById('sharedPersonFilter');
        const currentVal = personSelect.value;
        personSelect.innerHTML = '<option value="">All People</option>'; // Default option

        // Function to create an optgroup
        const createOptgroup = (label, peopleList) => {
            if (peopleList.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = label;
                peopleList.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.name;
                    opt.text = `${p.name} ($${Math.abs(p.balance).toFixed(2)})`;
                    optgroup.appendChild(opt);
                });
                personSelect.appendChild(optgroup);
            }
        };

        createOptgroup('Owes You', data.people.owes_me);
        createOptgroup('You Owe', data.people.i_owe);
        createOptgroup('Settled Up', data.people.settled);

        personSelect.value = currentVal;

        // 2. Render Unified Ledger
        const ledgerBody = document.getElementById('unifiedLedgerBody');
        if (data.ledger.length === 0) {
            ledgerBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 30px;">No shared activity found.</td></tr>';
        } else {
            ledgerBody.innerHTML = data.ledger.map(row => {
                const isPositive = row.net_change > 0;
                const isPayment = row.is_payment === 1;
                const isSplit = row.is_split;
                const context = !person ? `<span style="color:#764ba2; font-size:0.85em;"> (${row.payer === 'Me' ? row.person_name : row.payer})</span>` : '';
                const subtitle = isSplit
                    ? `<span style="color:#e67e22;">Payment Split${row.split_note ? ': ' + row.split_note : ''}</span>`
                    : (isPayment ? 'Settlement Payment' : 'Shared Expense');
                return `
                    <tr${isSplit ? ' style="background:#fffbf0;"' : ''}>
                        <td style="color: #888;">${formatDate(row.date)}</td>
                        <td>
                            <div style="font-weight: 600;">${row.description}${context}</div>
                            <div style="font-size: 0.8em; color: #999;">${subtitle}</div>
                            ${isSplit ? '' : renderTxnTags(row)}
                        </td>
                        <td>${row.payer === 'Me' ? 'I paid' : row.payer + ' paid'}</td>
                        <td style="text-align: right; font-weight: bold; color: ${isPositive ? '#27ae60' : '#e74c3c'};">
                            ${isPositive ? '+' : '-'}$${Math.abs(row.share_change || row.net_change).toFixed(2)}
                        </td>
                        <td style="text-align: right; font-weight: 700; color: ${row.running_balance >= 0 ? '#27ae60' : '#e74c3c'};">
                            ${row.running_balance < 0 ? '-' : ''}$${Math.abs(row.running_balance).toFixed(2)}
                        </td>
                    </tr>
                `;
            }).join('');
        }

        // 3. Update Net Balance Card
        const balance = data.net_balance;
        const card = document.getElementById('netBalanceCard');
        const label = document.getElementById('netBalanceLabel');
        const val = document.getElementById('netBalanceVal');

        if (balance > 0.01) {
            label.textContent = person ? `${person} owes you` : "Total Owed to You";
            card.style.background = "#2980b9";
            val.textContent = `$${balance.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        } else if (balance < -0.01) {
            label.textContent = person ? `You owe ${person}` : "Total You Owe";
            card.style.background = "#e67e22";
            val.textContent = `$${Math.abs(balance).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        } else {
            label.textContent = person ? "You are all settled up!" : "All Settled Up (Global)";
            card.style.background = "#27ae60";
            val.textContent = "$0.00";
        }

        // Show period net when a month filter is active
        const monthTotalEl = document.getElementById('sharedMonthTotal');
        if (data.is_filtered && monthTotalEl) {
            const mn = data.month_net;
            const sign = mn >= 0 ? '+' : '-';
            const color = mn >= 0 ? 'var(--pos)' : 'var(--neg)';
            monthTotalEl.innerHTML = `Period net: <strong style="color:${color};">${sign}$${Math.abs(mn).toFixed(2)}</strong>`;
        } else if (monthTotalEl) {
            monthTotalEl.textContent = '';
        }

    } catch (error) {
        console.error("Error loading shared ledger:", error);
    }
}

async function processSettlement() {
    const selectedPayment = document.querySelector('input[name="settle-payment"]:checked');
    const checkedExpenses = document.querySelectorAll('.settle-exp-check:checked');

    if (!selectedPayment) return alert("Please select a payment from the right table.");
    if (checkedExpenses.length === 0) return alert("Please select at least one expense from the left table.");

    const paymentShareId = selectedPayment.value;
    
    const settlements = Array.from(checkedExpenses).map(cb => {
        const shareId = cb.value;
        const customAmount = document.getElementById(`amt-${shareId}`).value;
        return {
            expenseShareId: shareId,
            amount: parseFloat(customAmount)
        };
    });

    // Client-side validation for non-zero/non-negative amounts
    if (settlements.some(s => s.amount <= 0)) {
        return alert("Please enter positive amounts for settlement.");
    }

    const response = await fetch('/api/settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentShareId, settlements })
    });

    if (response.ok) {
        alert("Settlement recorded successfully!");
        loadSharedLedger();
        loadSummary(true);
    } else {
        const err = await response.json();
        alert("Error: " + (err.error || "Failed to process settlement"));
    }
}




async function refreshSavedPeople() {
    const response = await fetch('/api/people');
    savedPeople = await response.json();
}


function updateSharedSentence(prefix) {
    const payerSelect = document.getElementById(prefix + 'Payer');
    const payerCustom = document.getElementById(prefix + 'PayerCustom');
    const payerLabel = document.getElementById(prefix + 'PayerLabel');
    const amtWrapper = document.getElementById(prefix + 'PaymentAmountWrapper');
    const containerId = prefix === 'add' ? 'addShareRowsContainer' : 'shareRowsContainer';
    const btnAdd = prefix === 'add' ? document.getElementById('btnAddShareAdd') : document.getElementById('btnAddShareEdit');
    const container = document.getElementById(containerId);
    const amount = document.getElementById(prefix + 'Amount')?.value || '';

    // Show/Hide Custom Payer field
    payerCustom.style.display = (payerSelect.value === 'Other') ? 'block' : 'none';

    if (isModalPaymentMode) {
        // Payment UI: Consolidate to first line
        if (btnAdd) btnAdd.style.display = 'none';
        container.style.display = 'none';
        amtWrapper.style.display = 'flex';

        payerLabel.textContent = "paid you";
        
        // Pre-fill with the current transaction's amount
        const amtInput = document.getElementById(prefix + 'PaymentAmount');
        if (!amtInput.value) amtInput.value = _currentEditAmount != null ? _currentEditAmount : (amount || '');
        
    } else {
        // Expense UI: Use multi-line splits
        payerLabel.textContent = "paid the full bill.";
        amtWrapper.style.display = 'none';
        container.style.display = 'flex';

        // Always show the add button — both "I paid" (others owe me) and
        // "someone else paid" (I owe them, plus optionally others) need it.
        if (btnAdd) btnAdd.style.display = 'block';

        // When someone else is the payer and the container is empty, seed one
        // row so the user has somewhere to enter their share amount immediately.
        if (payerSelect.value !== 'Me' && container.children.length === 0) {
            addShareRow(containerId);
        }
    }
}

function addShareRow(containerId = 'shareRowsContainer', name = '', amount = '') {
    const container = document.getElementById(containerId);
    const prefix = containerId.startsWith('add') ? 'add' : 'edit';
    const payerSelect = document.getElementById(prefix + 'Payer');
    const payerValue = payerSelect.value;
    const payerText = payerSelect.options[payerSelect.selectedIndex]?.text || payerValue;
    
    const row = document.createElement('div');
    row.className = 'share-row';
    row.style = "display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; background: transparent; padding: 8px; border-radius: 6px; border: 1px solid #ddd;";
    
    if (payerValue === 'Me') {
        // Scenario 1: [Person] owes me $ [Amount]
        const isOther = name !== '' && !savedPeople.includes(name) && name !== 'Me';
        let options = `<option value="Other" ${isOther ? 'selected' : ''}>Other...</option>`;
        savedPeople.forEach(p => {
            if (p !== 'Me') {
                options += `<option value="${p}" ${p === name ? 'selected' : ''}>${p}</option>`;
            }
        });

        row.innerHTML = `
            <select class="share-name-select" onchange="toggleShareOther(this)" style="padding: 5px; border-radius: 4px; border: 1px solid #ccc;">
                ${options}
            </select>
            <input type="text" class="share-name-custom" placeholder="Name" 
                   style="width: 100px; padding: 5px; border-radius: 4px; border: 1px solid #ccc; display: ${isOther ? 'block' : 'none'};" 
                   value="${isOther ? name : ''}">
            <span style="font-size: 0.9em; color: #666;">owes me</span>
            <div style="display: flex; align-items: center; gap: 3px;">
                <span style="font-weight: bold;">$</span>
                <input type="number" class="share-amount-input" step="0.01" style="width: 80px; padding: 5px; border-radius: 4px; border: 1px solid #ccc;" value="${amount}">
            </div>
            <button type="button" onclick="this.parentElement.remove()" style="background:none; border:none; color:#e74c3c; cursor:pointer; font-size: 1.2em;">✕</button>
        `;
    } else {
        // Scenario 2: They paid.
        if (isModalPaymentMode) {
            // Payment mode: "[Payer] paid me $X"
            row.innerHTML = `
                <span style="font-weight: 700; color: #2980b9;">${payerText}</span>
                <span style="font-size: 0.9em; color: #666;">paid me</span>
                <div style="display: flex; align-items: center; gap: 3px; margin-left: 10px;">
                    <span style="font-weight: bold;">$</span>
                    <input type="number" class="share-amount-input" step="0.01" style="width: 80px; padding: 5px; border-radius: 4px; border: 1px solid #ccc;" value="${amount}">
                </div>
                <input type="hidden" class="share-name-select" value="Me">
                <input type="hidden" class="share-name-custom" value="">
                <button type="button" onclick="this.parentElement.remove()" style="background:none; border:none; color:#e74c3c; cursor:pointer; font-size: 1.2em;">✕</button>
            `;
        } else {
            // Expense mode: "I owe [Payer] $X"
            row.innerHTML = `
                <span style="font-size: 0.9em; color: #666;">I owe</span>
                <span style="font-weight: 700; color: #2980b9;">${payerText}</span>
                <div style="display: flex; align-items: center; gap: 3px; margin-left: 10px;">
                    <span style="font-weight: bold;">$</span>
                    <input type="number" class="share-amount-input" step="0.01" style="width: 80px; padding: 5px; border-radius: 4px; border: 1px solid #ccc;" value="${amount}">
                </div>
                <input type="hidden" class="share-name-select" value="Me">
                <input type="hidden" class="share-name-custom" value="">
                <button type="button" onclick="this.parentElement.remove()" style="background:none; border:none; color:#e74c3c; cursor:pointer; font-size: 1.2em;">✕</button>
            `;
        }
    }
    container.appendChild(row);
}




function toggleShareOther(select) {
    const customInput = select.parentElement.querySelector('.share-name-custom');
    customInput.style.display = (select.value === 'Other') ? 'block' : 'none';
}

function setupModalDropdowns(isPaymentEdit) {
    // Rebuild Payer Dropdown
    const payerSelect = document.getElementById('editPayer');
    payerSelect.innerHTML = '';
    
    // Always use "I" for the value "Me" and put it first for consistency
    payerSelect.innerHTML = `<option value="Me">I</option>`;
    savedPeople.filter(p => p !== 'Me').forEach(p => {
        payerSelect.innerHTML += `<option value="${p}">${p}</option>`;
    });
    payerSelect.innerHTML += `<option value="Other">Other...</option>`;
    document.getElementById('editPayerCustom').style.display = 'none';

    // Rebuild Category Dropdown
    const listToUse = isPaymentEdit ? PAYMENT_CATEGORIES : TRACKED_CATEGORIES;
    const editCatSelect = document.getElementById('editCategory');
    editCatSelect.innerHTML = '<option value="">-- No Change --</option>';
    listToUse.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat; option.text = cat;
        editCatSelect.appendChild(option);
    });
}

// helper to render tags HTML
function renderTxnTags(txn) {
    if (!txn.tags || txn.tags.length === 0) return '';
    return `<div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
        ${txn.tags.map(tag => `
            <span class="transaction-tag" style="background:#e9e6fb; color:#4c2aa6; padding:4px 8px; border-radius:12px; font-size:0.85em; display:inline-flex; align-items:center; gap:6px;">
                <span>${tag.name}</span>
                <button onclick="removeTag(${txn.id}, ${tag.id})" style="background:none; border:none; color:#777; cursor:pointer; font-weight:700; line-height:1;">×</button>
            </span>
        `).join('')}
    </div>`;
}

async function removeTag(txnId, tagId) {
    if (!confirm('Remove this tag from the transaction?')) return;
    try {
        const resp = await fetch(`/api/transaction/${txnId}/tag/${tagId}`, { method: 'DELETE' });
        if (resp.ok) {
            // Refresh the table (safe, cheap)
            await loadFullTransactions();
            if (document.getElementById('shared').classList.contains('active')) {
                loadSharedLedger();
            }
            if (document.getElementById('detailedBreakdowns').classList.contains('active')) {
                loadBreakdownData();
            }
        } else {
            const err = await resp.json();
            alert('Failed to remove tag: ' + (err.error || resp.statusText));
        }
    } catch (e) {
        console.error(e);
        alert('Network error removing tag');
    }
}


//---------------------------------------------------------------
window.onclick = function(event) {
    const modal = document.getElementById('editModal');
    const addModal = document.getElementById('addModal');
    const tagModal = document.getElementById('tagModal');
    const settingsModal = document.getElementById('settingsModal');
    if (event.target == modal) {
        closeEditModal();
    } else if (event.target == addModal) {
        closeAddModal();
    } else if (event.target == tagModal) {
        closeTagModal();
    } else if (event.target == settingsModal) {
        closeSettingsModal();
    }
}
//---------------------------------------------------------------
// Plaid integration
//---------------------------------------------------------------

let plaidHandler = null;
let plaidCandidates = [];
let plaidFilteredOut = [];

async function _plaidOnSuccess(public_token, metadata) {
    const account = metadata.accounts[0];
    const institutionName = metadata.institution.name;

    const displayName = window.prompt(
        `What would you like to call this account?\n(e.g. "Chase", "Capital One", "Venmo")`,
        institutionName
    );
    if (displayName === null) return;

    await fetch('/api/plaid/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            public_token,
            institution_name: institutionName,
            account_name: displayName.trim() || institutionName,
            account_id: account.id,
        })
    });
    await loadPlaidAccounts();
}

async function initPlaidLink() {
    // Fetch a fresh Link token from the backend and initialise the Plaid SDK
    const res = await fetch('/api/plaid/link-token', { method: 'POST' });
    const data = await res.json();
    if (data.error) { alert('Could not initialise Plaid: ' + data.error); return; }

    plaidHandler = Plaid.create({
        token: data.link_token,
        onSuccess: _plaidOnSuccess,
        onExit: (err) => { if (err) console.error('Plaid Link exit error:', err); },
    });
}

// OAuth return handler — Chase and other OAuth institutions redirect back here
// with ?oauth_state_id=... after the user authenticates on their bank's website.
async function _handlePlaidOAuthReturn() {
    const oauthStateId = new URLSearchParams(window.location.search).get('oauth_state_id');
    if (!oauthStateId) return;

    // Clean the OAuth params from the URL immediately so a page refresh doesn't re-trigger
    window.history.replaceState({}, '', window.location.pathname);

    const res = await fetch('/api/plaid/link-token', { method: 'POST' });
    const data = await res.json();
    if (data.error) { alert('Plaid OAuth return failed: ' + data.error); return; }

    Plaid.create({
        token: data.link_token,
        receivedRedirectUri: window.location.href,
        onSuccess: _plaidOnSuccess,
        onExit: (err) => { if (err) console.error('Plaid OAuth exit:', err); },
    }).open();
}

function openPlaidLink() {
    if (!plaidHandler) { alert('Plaid is still initialising — please try again in a moment.'); return; }
    plaidHandler.open();
}

async function loadPlaidAccounts() {
    const res = await fetch('/api/plaid/accounts');
    const accounts = await res.json();
    const container = document.getElementById('plaidAccountsList');

    if (!accounts.length) {
        container.innerHTML = '<span>No accounts connected yet.</span>';
        return;
    }

    container.innerHTML = accounts.map(a => `
        <div style="display: flex; justify-content: space-between; align-items: center;
                    padding: 10px 14px; background: white; border: 1px solid #eee;
                    border-radius: 8px; margin-bottom: 8px;">
            <div>
                <strong>${a.institution_name}</strong>
                <span style="color: #666; margin-left: 8px; font-size: 0.9em;">${a.account_name}</span>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="btn-edit" style="min-width: auto; padding: 4px 10px; font-size: 0.8em; background: #e67e22;"
                    onclick="renamePlaidAccount(${a.id}, '${a.account_name}')">Rename</button>
                <button class="btn-delete" style="min-width: auto; padding: 4px 10px; font-size: 0.8em;"
                    onclick="disconnectPlaidAccount(${a.id}, '${a.institution_name}')">Disconnect</button>
            </div>
        </div>
    `).join('');

    // Re-init Link token so it's fresh for the next connect
    initPlaidLink();
}

async function renamePlaidAccount(id, currentName) {
    const newName = window.prompt('Rename this account:', currentName);
    if (!newName || newName.trim() === currentName) return;
    await fetch(`/api/plaid/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_name: newName.trim() })
    });
    await loadPlaidAccounts();
}

async function disconnectPlaidAccount(id, name) {
    if (!confirm(`Disconnect ${name}? This won't delete any imported transactions.`)) return;
    await fetch(`/api/plaid/accounts/${id}`, { method: 'DELETE' });
    await loadPlaidAccounts();
}

async function fetchPlaidCandidates() {
    const startDate = document.getElementById('plaidStartDate').value;
    const endDate   = document.getElementById('plaidEndDate').value;
    if (!startDate) { alert('Please select a start date.'); return; }
    if (!endDate)   { alert('Please select an end date.'); return; }
    if (startDate > endDate) { alert('Start date must be on or before end date.'); return; }

    const status = document.getElementById('plaidStatusMessage');
    status.textContent = 'Fetching transactions from your banks…';
    document.getElementById('plaidCandidatesSection').style.display = 'none';

    try {
        const res = await fetch('/api/plaid/fetch-transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ since_date: startDate, end_date: endDate })
        });
        const data = await res.json();
        if (data.error) { status.textContent = 'Error: ' + data.error; return; }

        plaidCandidates = data.candidates || [];
        plaidFilteredOut = data.filtered_out || [];
        status.textContent = '';
        renderPlaidCandidates();
    } catch (e) {
        status.textContent = 'Network error — check the server console.';
    }
}

function renderPlaidCandidates() {
    const section = document.getElementById('plaidCandidatesSection');
    const body = document.getElementById('plaidCandidatesBody');
    const count = document.getElementById('plaidCandidateCount');

    renderFilteredOutTable();

    if (!plaidCandidates.length) {
        document.getElementById('plaidStatusMessage').textContent = plaidFilteredOut.length ? '' : 'No new transactions found.';
        section.style.display = 'none';
        return;
    }

    count.textContent = `(${plaidCandidates.length} new)`;
    body.innerHTML = plaidCandidates.map((t, i) => {
        const amount = parseFloat(t.amount);
        const amountStr = `$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
        const amountColor = amount < 0 ? '#27ae60' : '#e74c3c';
        const amountLabel = amount < 0 ? `<span style="color:${amountColor}">+${amountStr}</span>`
                                        : `<span style="color:${amountColor}">-${amountStr}</span>`;
        const isPending = t.pending === true;
        const statusBadge = isPending
            ? `<span style="font-size:0.8em; font-weight:600; padding:2px 8px; border-radius:10px; background:#fff3cd; color:#856404;">Pending</span>`
            : `<span style="font-size:0.8em; font-weight:600; padding:2px 8px; border-radius:10px; background:#d1e7dd; color:#0f5132;">Settled</span>`;
        const rowStyle = isPending ? 'opacity:0.55;' : '';
        return `
            <tr style="${rowStyle}">
                <td style="text-align: center;">
                    <input type="checkbox" class="plaid-candidate-check" data-index="${i}" ${isPending ? 'disabled title="Wait for this transaction to settle before importing"' : ''}>
                </td>
                <td>${t.date}</td>
                <td>${t.description}</td>
                <td style="font-size: 0.85em; color: #666;">${t.institution_name} — ${t.card_name}</td>
                <td style="font-size: 0.85em; color: #888;">${t.bank_category || '—'}</td>
                <td>${statusBadge}</td>
                <td style="text-align: right;">${amountLabel}</td>
            </tr>
        `;
    }).join('');

    section.style.display = 'block';
}

function plaidSelectAll(checked) {
    document.querySelectorAll('.plaid-candidate-check').forEach(cb => {
        if (!cb.disabled) cb.checked = checked;
    });
}

function moveToFiltered() {
    const checked = Array.from(document.querySelectorAll('.plaid-candidate-check:checked'));
    if (!checked.length) { alert('Select at least one transaction to filter out.'); return; }

    const indicesToRemove = new Set(checked.map(cb => parseInt(cb.dataset.index)));
    plaidFilteredOut = [...plaidFilteredOut, ...plaidCandidates.filter((_, i) => indicesToRemove.has(i))];
    plaidCandidates = plaidCandidates.filter((_, i) => !indicesToRemove.has(i));

    renderPlaidCandidates();
}

function moveBackToImportable(plaidId) {
    const txn = plaidFilteredOut.find(t => t.plaid_transaction_id === plaidId);
    if (!txn) return;

    plaidFilteredOut = plaidFilteredOut.filter(t => t.plaid_transaction_id !== plaidId);
    plaidCandidates = [txn, ...plaidCandidates].sort((a, b) => b.date.localeCompare(a.date));

    renderPlaidCandidates();
}

function renderFilteredOutTable() {
    const section = document.getElementById('plaidFilteredOutSection');
    const body = document.getElementById('plaidFilteredOutBody');
    const count = document.getElementById('plaidFilteredOutCount');

    if (!plaidFilteredOut.length) {
        section.style.display = 'none';
        return;
    }

    count.textContent = `(${plaidFilteredOut.length})`;
    body.innerHTML = plaidFilteredOut.map(t => {
        const amount = parseFloat(t.amount);
        const amountStr = `$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
        const amountColor = amount < 0 ? '#27ae60' : '#e74c3c';
        const amountLabel = amount < 0
            ? `<span style="color:${amountColor}">+${amountStr}</span>`
            : `<span style="color:${amountColor}">-${amountStr}</span>`;
        return `
            <tr>
                <td>${t.date}</td>
                <td>${t.description}</td>
                <td style="font-size: 0.85em; color: #666;">${t.institution_name} — ${t.card_name}</td>
                <td style="font-size: 0.85em; color: #888;">${t.bank_category || '—'}</td>
                <td style="text-align: right;">${amountLabel}</td>
                <td style="text-align: center;">
                    <button onclick="moveBackToImportable('${t.plaid_transaction_id}')"
                            class="toggle-btn" style="font-size: 0.8em; padding: 3px 8px;">Restore</button>
                </td>
            </tr>
        `;
    }).join('');

    section.style.display = 'block';
}

// Shared split modal state
let _splitResolve = null;

function addSplitPersonRow(personName = '', shareAmount = '') {
    const container = document.getElementById('splitPersonRows');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:8px;';
    row.innerHTML = `
        <input type="text" placeholder="Person's name" value="${personName}"
               style="flex:2; padding:9px; border:1px solid #ddd; border-radius:6px; font-size:0.9em;">
        <span style="color:#888;">owes $</span>
        <input type="number" placeholder="0.00" value="${shareAmount}" min="0" step="0.01"
               style="flex:1; padding:9px; border:1px solid #ddd; border-radius:6px; font-size:0.9em;">
        <button onclick="this.parentElement.remove()" style="background:none; border:none; color:#e74c3c; font-size:1.2em; cursor:pointer; padding:0 4px;">×</button>
    `;
    container.appendChild(row);
}

function resolveSharedSplit(apply) {
    document.getElementById('sharedSplitModal').style.display = 'none';
    if (!_splitResolve) return;

    if (!apply) {
        _splitResolve(null);
        _splitResolve = null;
        return;
    }

    const rows = document.querySelectorAll('#splitPersonRows > div');
    const shares = [];
    rows.forEach(row => {
        const inputs = row.querySelectorAll('input');
        const name = inputs[0].value.trim();
        const amount = parseFloat(inputs[1].value);
        if (name && !isNaN(amount) && amount > 0) {
            shares.push({ person_name: name, share_amount: amount });
        }
    });

    _splitResolve(shares.length ? shares : null);
    _splitResolve = null;
}

function showSharedSplitModal(description, newAmount, profile) {
    return new Promise(resolve => {
        _splitResolve = resolve;

        document.getElementById('splitModalDesc').textContent = `"${description}"`;
        document.getElementById('splitPersonRows').innerHTML = '';

        const amountMatch = profile && Math.abs(profile.most_recent_amount - newAmount) < 0.01;

        let subText;
        if (!profile) {
            subText = `No previous split found for this transaction ($${newAmount.toFixed(2)}). Enter the split below, or click "Not shared".`;
        } else if (amountMatch) {
            subText = `Previously split at the same amount ($${newAmount.toFixed(2)}). The suggested split is pre-filled — adjust if needed.`;
        } else {
            subText = `Previously shared at $${profile.most_recent_amount.toFixed(2)}, but this charge is $${newAmount.toFixed(2)}. Confirm the split below.`;
        }
        document.getElementById('splitModalSub').textContent = subText;

        if (profile) {
            // Pre-fill with previous shares; if amount changed, scale proportionally
            profile.shares.forEach(s => {
                let suggestedAmount = s.share_amount;
                if (!amountMatch && profile.most_recent_amount > 0) {
                    // Scale the share proportionally to the new total
                    suggestedAmount = parseFloat(((s.share_amount / profile.most_recent_amount) * newAmount).toFixed(2));
                }
                addSplitPersonRow(s.person_name, suggestedAmount);
            });
        } else {
            addSplitPersonRow(); // blank row to start
        }

        document.getElementById('sharedSplitModal').style.display = 'block';
    });
}

async function importSelectedPlaidTransactions() {
    const checked = Array.from(document.querySelectorAll('.plaid-candidate-check:checked'))
        .map(cb => plaidCandidates[parseInt(cb.dataset.index)]);

    if (!checked.length) { alert('No transactions selected.'); return; }

    const status = document.getElementById('plaidImportStatus');
    const uniqueDescs = [...new Set(checked.map(t => t.description))];

    // 1. Category + tags profile lookup
    status.textContent = 'Looking up profiles…';
    console.log('[import] step 1: category profiles for', uniqueDescs);
    const profileRes = await fetch('/api/plaid/lookup-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descriptions: uniqueDescs })
    });
    const profiles = await profileRes.json();
    console.log('[import] step 1 done:', profiles);

    // 2. Shared split profile lookup
    console.log('[import] step 2: shared profiles');
    const sharedRes = await fetch('/api/plaid/lookup-shared-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descriptions: uniqueDescs })
    });
    const sharedProfiles = await sharedRes.json();
    console.log('[import] step 2 done:', sharedProfiles);

    // 3. Resolve category/tag conflicts
    console.log('[import] step 3: category conflict resolution');
    const resolvedProfiles = {};
    for (const desc of uniqueDescs) {
        const profile = profiles[desc];
        if (!profile || profile.status === 'none') {
            resolvedProfiles[desc] = null;
        } else if (profile.status === 'unique') {
            resolvedProfiles[desc] = { category: profile.category, tags: profile.tags };
        } else {
            status.textContent = 'Resolving category conflicts…';
            console.log('[import] step 3: conflict modal for', desc);
            resolvedProfiles[desc] = await showConflictModal(desc, profile.options);
            console.log('[import] step 3: resolved', desc, '->', resolvedProfiles[desc]);
        }
    }
    console.log('[import] step 3 done');

    // 4. Resolve shared splits
    console.log('[import] step 4: shared split resolution');
    const resolvedShares = {};
    const resolvedSharesById = {};
    const descGroups = {};
    checked.forEach(t => {
        if (!descGroups[t.description]) descGroups[t.description] = [];
        descGroups[t.description].push(t);
    });

    for (const desc of uniqueDescs) {
        const sharedProfile = sharedProfiles[desc];
        if (!sharedProfile) { console.log('[import] step 4: no shared history for', desc); continue; }

        const group = descGroups[desc];
        const uniqueAmounts = [...new Set(group.map(t => t.amount))];
        console.log('[import] step 4: split modal for', desc, 'amounts:', uniqueAmounts);

        for (const amount of uniqueAmounts) {
            status.textContent = 'Reviewing shared splits…';
            const shares = await showSharedSplitModal(desc, amount, sharedProfile);
            console.log('[import] step 4: resolved split for', desc, amount, '->', shares);
            group.filter(t => t.amount === amount).forEach(t => {
                resolvedSharesById[t.plaid_transaction_id] = shares;
            });
        }
    }
    console.log('[import] step 4 done');

    // 5. Enrich each transaction with resolved data
    const enriched = checked.map(t => ({
        ...t,
        category: resolvedProfiles[t.description]?.category || '',
        resolved_tags: resolvedProfiles[t.description]?.tags || [],
        resolved_shares: resolvedSharesById[t.plaid_transaction_id] || null,
    }));

    status.textContent = 'Importing…';

    const res = await fetch('/api/plaid/import-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: enriched })
    });
    const data = await res.json();

    if (data.error) { status.textContent = 'Error: ' + data.error; return; }

    status.textContent = `✓ ${data.inserted} transaction${data.inserted !== 1 ? 's' : ''} imported.`;

    const importedIds = new Set(checked.map(t => t.plaid_transaction_id));
    plaidCandidates = plaidCandidates.filter(t => !importedIds.has(t.plaid_transaction_id));
    renderPlaidCandidates();

    await loadFullTransactions();
    loadSummary(true);
}

function resolveConflict(choice) {
    document.getElementById('profileConflictModal').style.display = 'none';
    if (!_conflictResolve) return;

    if (!apply) {
        _splitResolve(null);
        _splitResolve = null;
        return;
    }

    const rows = document.querySelectorAll('#splitPersonRows > div');
    const shares = [];
    rows.forEach(row => {
        const inputs = row.querySelectorAll('input');
        const name = inputs[0].value.trim();
        const amount = parseFloat(inputs[1].value);
        if (name && !isNaN(amount) && amount > 0) {
            shares.push({ person_name: name, share_amount: amount });
        }
    });

    _splitResolve(shares.length ? shares : null);
    _splitResolve = null;
}

function showSharedSplitModal(description, newAmount, profile) {
    return new Promise(resolve => {
        _splitResolve = resolve;

        document.getElementById('splitModalDesc').textContent = `"${description}"`;
        document.getElementById('splitPersonRows').innerHTML = '';

        const amountMatch = profile && Math.abs(profile.most_recent_amount - newAmount) < 0.01;

        let subText;
        if (!profile) {
            subText = `No previous split found for this transaction ($${newAmount.toFixed(2)}). Enter the split below, or click "Not shared".`;
        } else if (amountMatch) {
            subText = `Previously split at the same amount ($${newAmount.toFixed(2)}). The suggested split is pre-filled — adjust if needed.`;
        } else {
            subText = `Previously shared at $${profile.most_recent_amount.toFixed(2)}, but this charge is $${newAmount.toFixed(2)}. Confirm the split below.`;
        }
        document.getElementById('splitModalSub').textContent = subText;

        if (profile) {
            // Pre-fill with previous shares; if amount changed, scale proportionally
            profile.shares.forEach(s => {
                let suggestedAmount = s.share_amount;
                if (!amountMatch && profile.most_recent_amount > 0) {
                    // Scale the share proportionally to the new total
                    suggestedAmount = parseFloat(((s.share_amount / profile.most_recent_amount) * newAmount).toFixed(2));
                }
                addSplitPersonRow(s.person_name, suggestedAmount);
            });
        } else {
            addSplitPersonRow(); // blank row to start
        }

        document.getElementById('sharedSplitModal').style.display = 'block';
    });
}


//---------------------------------------------------------------
// Saved Breakdown Views
//---------------------------------------------------------------

const COMPARISON_COLORS = ['#5B9BD5', '#E0795F', '#D2A859', '#9B7BD0', '#4FB6A8', '#D27FB0'];
let _savedBreakdownViews = [];
let activeComparisonViews = new Map(); // viewId -> color

async function loadSavedViews() {
    const res = await fetch('/api/breakdown-views');
    _savedBreakdownViews = await res.json();
    renderSavedViews();
}

function renderSavedViews() {
    const category = document.getElementById('breakdownCategory').value;
    const views = _savedBreakdownViews.filter(v => v.category === category);
    const container = document.getElementById('savedViewsList');
    if (!views.length) {
        container.innerHTML = '<span style="font-size:0.8em; color:#bbb; font-style:italic;">No saved views yet.</span>';
        return;
    }
    container.innerHTML = views.map(v => {
        const color = activeComparisonViews.get(v.id);
        const isActive = !!color;
        return `
            <div style="display:flex; align-items:center; gap:8px; padding:7px 10px;
                        background:${isActive ? color + '18' : '#f8f0ff'};
                        border:2px solid ${isActive ? color : '#d0b8f5'};
                        border-radius:6px; cursor:pointer;"
                 onclick="toggleComparisonView(${v.id})">
                <div style="width:12px; height:12px; border-radius:50%; flex-shrink:0;
                            background:${isActive ? color : '#ccc'};
                            border:2px solid ${isActive ? color : '#aaa'};"></div>
                <span style="flex:1; font-size:0.85em; font-weight:600;
                             color:${isActive ? '#222' : '#4c2aa6'};
                             overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                      title="${v.name}">${v.name}</span>
                <button onclick="event.stopPropagation(); deleteSavedView(${v.id})"
                        style="background:none; border:none; color:#e74c3c; cursor:pointer;
                               font-size:1.1em; line-height:1; padding:0 2px; flex-shrink:0;">×</button>
            </div>
        `;
    }).join('');
}

function toggleComparisonView(viewId) {
    if (activeComparisonViews.has(viewId)) {
        activeComparisonViews.delete(viewId);
    } else {
        const color = COMPARISON_COLORS[activeComparisonViews.size % COMPARISON_COLORS.length];
        activeComparisonViews.set(viewId, color);
    }
    renderSavedViews();
    loadBreakdownData();
}

async function saveCurrentBreakdownView() {
    const name = window.prompt('Name this view:');
    if (!name || !name.trim()) return;

    const category = document.getElementById('breakdownCategory').value;
    const tagIds = JSON.stringify(
        Array.from(document.querySelectorAll('.breakdown-tag-check:checked')).map(i => parseInt(i.value))
    );

    const res = await fetch('/api/breakdown-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), category, tag_ids: tagIds,
                               view_mode: 'net', time_range: '6m' })
    });
    if (res.ok) await loadSavedViews();
    else alert('Failed to save view.');
}

async function deleteSavedView(id) {
    if (!confirm('Delete this saved view?')) return;
    activeComparisonViews.delete(id);
    await fetch(`/api/breakdown-views/${id}`, { method: 'DELETE' });
    await loadSavedViews();
    loadBreakdownData();
}

async function loadComparisonData() {
    const year = document.getElementById('breakdownYear').value;
    const month = document.getElementById('breakdownMonth').value;

    const results = await Promise.all(
        Array.from(activeComparisonViews.entries()).map(async ([viewId, color]) => {
            const view = _savedBreakdownViews.find(v => v.id === viewId);
            if (!view) return null;
            const tagIds = JSON.parse(view.tag_ids);
            const params = new URLSearchParams({
                year, month,
                category: view.category,
                view_mode: currentViewMode,
                time_range: breakdownChartRange,
            });
            tagIds.forEach(id => params.append('tag_ids', id));
            const res = await fetch(`/api/breakdown-report?${params.toString()}`);
            const data = await res.json();
            return { view, color, data };
        })
    );

    const valid = results.filter(Boolean);
    renderComparisonChart(valid);
    renderComparisonTable(valid);
}

function renderComparisonChart(results) {
    const traces = results.map(({ view, color, data }) => ({
        x: data.graph.map(g => g.month),
        y: data.graph.map(g => g.total),
        type: 'scatter',
        mode: 'lines+markers',
        name: view.name,
        line: { color, width: 3 },
        fill: 'tozeroy',
        fillcolor: color + '18',
        hovertemplate: `<b>${view.name}</b><br>%{x}<br>$%{y:,.2f}<extra></extra>`
    }));

    if (results.length === 1) {
        const y = results[0].data.graph.map(g => g.total);
        const x = results[0].data.graph.map(g => g.month);
        const average = y.length > 0 ? y.reduce((s, v) => s + v, 0) / y.length : 0;
        traces.push({
            x, y: Array(y.length).fill(average),
            type: 'scatter',
            mode: 'lines',
            name: `Average ($${average.toFixed(2)})`,
            line: { color: '#E87B61', width: 2, dash: 'dash' },
            hovertemplate: '<b>Average</b><br>$%{y:,.2f}<extra></extra>'
        });
    }

    const mobile = isMobile();
    Plotly.newPlot('breakdownHistoryChart', traces, {
        font: { color: '#C9CDD3', family: 'Schibsted Grotesk, sans-serif' },
        xaxis: { title: mobile ? '' : 'Month', tickfont: { color: '#A2A7B0', size: mobile ? 9 : 11 }, tickangle: mobile ? -55 : 0, gridcolor: 'rgba(0,0,0,0)', linecolor: '#565C66' },
        yaxis: { title: mobile ? '' : 'Total Spend ($)', tickprefix: '$', tickfont: { color: '#A2A7B0', size: mobile ? 9 : 11 }, gridcolor: '#4D535D', zerolinecolor: '#565C66' },
        margin: chartMargins(),
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: mobile ? -0.4 : -0.3, font: { color: '#C9CDD3', size: mobile ? 10 : 12 } }
    }, { responsive: true, displayModeBar: false });
}

function renderComparisonTable(results) {
    const tableBody = document.getElementById('breakdownTableBody');

    // Flatten all rows, tagging each with its view name and color
    const allRows = [];
    results.forEach(({ view, color, data }) => {
        (data.table || []).forEach(row => allRows.push({ ...row, _viewName: view.name, _color: color }));
    });

    if (!allRows.length) {
        tableBody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:#888;">No transactions found for the selected views.</td></tr>';
        return;
    }

    // Sort newest first, then group by month
    allRows.sort((a, b) => b.date.localeCompare(a.date));
    const byMonth = {};
    const monthOrder = [];
    allRows.forEach(row => {
        const key = row.date.substring(0, 7);
        if (!byMonth[key]) { byMonth[key] = []; monthOrder.push(key); }
        byMonth[key].push(row);
    });

    let html = '';
    let grandTotal = 0;
    monthOrder.forEach(key => {
        const rows = byMonth[key];
        const [yr, mo] = key.split('-');
        const monthLabel = new Date(parseInt(yr), parseInt(mo) - 1, 1)
            .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const monthTotal = rows.reduce((sum, r) => sum + r.display_amount, 0);
        grandTotal += monthTotal;

        html += `
            <tr style="border-top:3px solid #2c3e50; background:#2c3e50;">
                <td colspan="2" style="font-weight:700; padding:7px 10px; color:#fff; font-size:0.88em;">${monthLabel}</td>
                <td style="text-align:right; font-weight:700; padding:7px 10px; color:#fff; white-space:nowrap;">$${monthTotal.toLocaleString(undefined, {minimumFractionDigits:2})}</td>
            </tr>
        `;
        rows.forEach(row => {
            html += `
                <tr style="border-left:4px solid ${row._color}; background:${row._color}12;">
                    <td style="white-space:nowrap;">${formatDate(row.date)}</td>
                    <td>
                        <div style="font-weight:600;">${row.description}</div>
                        <div style="font-size:0.78em; font-weight:700; color:${row._color}; margin-top:2px;">${row._viewName}</div>
                        ${renderTxnTags(row)}
                    </td>
                    <td style="text-align:right; font-weight:700; white-space:nowrap;">$${row.display_amount.toLocaleString(undefined, {minimumFractionDigits:2})}</td>
                </tr>
            `;
        });
    });

    tableBody.innerHTML = html;
    tableBody.innerHTML += `
        <tfoot style="border-top:2px solid #333; font-weight:bold; background:#f8f9fa;">
            <tr><td>TOTAL</td><td colspan="2" style="text-align:right;">$${grandTotal.toLocaleString(undefined, {minimumFractionDigits:2})}</td></tr>
        </tfoot>
    `;
}

function resolveConflict(choice) {
    document.getElementById('profileConflictModal').style.display = 'none';
    if (!_conflictResolve) return;

    if (choice === 'selected') {
        const selected = document.querySelector('input[name="conflictOption"]:checked');
        _conflictResolve(selected ? JSON.parse(selected.value) : null);
    } else {
        _conflictResolve(null); // Leave blank
    }
    _conflictResolve = null;
}

function showConflictModal(description, options) {
    // Returns a Promise that resolves with the chosen {category, tags} or null
    return new Promise(resolve => {
        _conflictResolve = resolve;
        document.getElementById('conflictModalDesc').textContent = `"${description}"`;
        document.getElementById('conflictOptionsList').innerHTML = options.map((opt, i) => {
            const tagStr = opt.tags.length ? opt.tags.join(', ') : 'No tags';
            const catStr = opt.category || 'No category';
            return `
                <label style="display:flex; align-items:flex-start; gap:10px; padding:10px 12px;
                              border:1px solid #eee; border-radius:8px; margin-bottom:8px; cursor:pointer;
                              transition:background 0.15s;" onmouseover="this.style.background='#f8f0ff'"
                              onmouseout="this.style.background='white'">
                    <input type="radio" name="conflictOption" value='${JSON.stringify(opt)}'
                           ${i === 0 ? 'checked' : ''} style="margin-top:3px; accent-color:#764ba2;">
                    <div>
                        <div style="font-weight:600; color:#333;">${catStr}</div>
                        <div style="font-size:0.82em; color:#888; margin-top:2px;">Tags: ${tagStr}</div>
                    </div>
                </label>
            `;
        }).join('');
        document.getElementById('profileConflictModal').style.display = 'block';
    });
}


//---------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async function() {
    // Handle Plaid OAuth return (Chase etc.) before anything else
    await _handlePlaidOAuthReturn();

    // 1. Setup the static dropdowns (Years and Rule Categories)
    setupYearDropdown();
    setupCategoryDropdowns();

    // Set default year and month to current
    const now = new Date();
    document.getElementById('yearSelect').value = now.getFullYear();
    updateMonthDropdown(); // populate months for this year
    document.getElementById('monthSelect').value = String(now.getMonth() + 1).padStart(2, '0');

    // Set default view mode to Net
    setViewMode('net');

    // Set default chart range button to 6M
    const defaultRangeBtn = document.querySelector('.chart-time-controls .time-btn[onclick*="\'6m\'"]');
    if (defaultRangeBtn) {
        document.querySelectorAll('#overview .chart-time-controls .time-btn').forEach(b => b.classList.remove('active'));
        defaultRangeBtn.classList.add('active');
    }

    // 2. IMPORTANT: Wait for the data to actually arrive from the database
    // This populates the 'allTransactions' variable
    await loadFullTransactions();
    await refreshSavedPeople();
    // Populate header greeting from stored display name / email
    fetch('/api/account').then(r => r.json()).then(d => updateHeaderName(d.display_name || d.email));
    
    // 3. Now that data is present, build the dynamic bank/account filters
    updateBankCategoryDropdown();
    updateBankNameDropdown(); 
    
    // 4. Load the overview summaries and chart
    loadSummary();

    // 5. Open the default tab (Overview)
    openTab(null, 'overview');

    // 6. Shared ledger prefetch is triggered at the end of loadSummary's Phase 2

    // 7. Initialise Plaid (fetches a Link token; sets smart default date window)
    const today = now.toISOString().split('T')[0];
    const dayOfMonth = now.getDate();
    let startDate;
    if (dayOfMonth <= 15) {
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(now.getDate() - 30);
        startDate = thirtyDaysAgo.toISOString().split('T')[0];
    } else {
        startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    }
    document.getElementById('plaidStartDate').value = startDate;
    document.getElementById('plaidEndDate').value = today;
    loadPlaidAccounts();
    initPlaidLink();
});

// ── Settings modal ────────────────────────────────────────────────────────────

let settingsTab = 'account';

function openSettingsModal() {
    document.getElementById('settingsModal').style.display = 'block';
    switchSettingsTab(settingsTab);
}

function closeSettingsModal() {
    document.getElementById('settingsModal').style.display = 'none';
    // Clear sensitive fields
    ['acctCurrentPw', 'acctNewPw', 'acctConfirmPw', 'acctDeleteConfirm'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    ['profileMsg', 'passwordMsg', 'deleteMsg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
}

function switchSettingsTab(tab) {
    settingsTab = tab;
    document.getElementById('settingsPanelAccount').style.display    = tab === 'account'    ? 'block' : 'none';
    document.getElementById('settingsPanelCategories').style.display = tab === 'categories' ? 'block' : 'none';

    const acctBtn = document.getElementById('stAccount');
    const catBtn  = document.getElementById('stCategories');
    if (tab === 'account') {
        acctBtn.style.background = 'var(--surface-2)'; acctBtn.style.color = 'var(--ink)';
        catBtn.style.background  = 'none';             catBtn.style.color  = 'var(--muted)';
        loadAccountSettings();
    } else {
        catBtn.style.background  = 'var(--surface-2)'; catBtn.style.color = 'var(--ink)';
        acctBtn.style.background = 'none';              acctBtn.style.color = 'var(--muted)';
        loadCategories();
    }
}

async function loadAccountSettings() {
    const res  = await fetch('/api/account');
    const data = await res.json();
    document.getElementById('acctDisplayName').value = data.display_name || '';
    document.getElementById('acctEmail').value        = data.email || '';
    updateHeaderName(data.display_name || data.email);
}

function updateHeaderName(name) {
    const el = document.getElementById('headerDisplayName');
    if (el) el.textContent = name ? `Hi, ${name.split(' ')[0]}` : '';
}

async function saveProfile() {
    const display_name = document.getElementById('acctDisplayName').value.trim();
    const email        = document.getElementById('acctEmail').value.trim();
    const msg          = document.getElementById('profileMsg');
    const res = await fetch('/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name, email })
    });
    const data = await res.json();
    if (res.ok) {
        msg.style.color = 'var(--accent)';
        msg.textContent = 'Saved.';
        updateHeaderName(display_name || email);
    } else {
        msg.style.color = 'var(--neg)';
        msg.textContent = data.error || 'Could not save.';
    }
    setTimeout(() => { msg.textContent = ''; }, 3000);
}

async function changePassword() {
    const current  = document.getElementById('acctCurrentPw').value;
    const newPw    = document.getElementById('acctNewPw').value;
    const confirm  = document.getElementById('acctConfirmPw').value;
    const msg      = document.getElementById('passwordMsg');
    if (newPw !== confirm) {
        msg.style.color = 'var(--neg)';
        msg.textContent = 'New passwords do not match.';
        return;
    }
    const res = await fetch('/api/account/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: newPw })
    });
    const data = await res.json();
    if (res.ok) {
        msg.style.color = 'var(--accent)';
        msg.textContent = 'Password updated.';
        ['acctCurrentPw', 'acctNewPw', 'acctConfirmPw'].forEach(id => document.getElementById(id).value = '');
    } else {
        msg.style.color = 'var(--neg)';
        msg.textContent = data.error || 'Could not update password.';
    }
    setTimeout(() => { msg.textContent = ''; }, 4000);
}

function exportData() {
    window.location.href = '/api/account/export';
}

async function generateInviteCode() {
    const display = document.getElementById('inviteCodeDisplay');
    const copyBtn = document.getElementById('inviteCopyBtn');
    const msg     = document.getElementById('inviteMsg');
    display.textContent = '';
    copyBtn.style.display = 'none';
    msg.textContent = 'Generating…';
    const res  = await fetch('/api/generate-invite', { method: 'POST' });
    const data = await res.json();
    if (data.code) {
        display.textContent = data.code;
        copyBtn.style.display = 'inline-block';
        msg.textContent = 'Single-use — share this code with your invitee.';
    } else {
        msg.textContent = data.error || 'Failed to generate code.';
    }
}

function copyInviteCode() {
    const code = document.getElementById('inviteCodeDisplay').textContent;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
        const msg = document.getElementById('inviteMsg');
        msg.textContent = 'Copied to clipboard!';
        setTimeout(() => { msg.textContent = 'Single-use — share this code with your invitee.'; }, 2000);
    });
}

async function closeAccount() {
    const email = document.getElementById('acctDeleteConfirm').value.trim().toLowerCase();
    const msg   = document.getElementById('deleteMsg');
    if (!email) { msg.textContent = 'Please enter your email to confirm.'; return; }
    const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (res.ok) {
        window.location.href = '/login';
    } else {
        msg.textContent = data.error || 'Could not delete account.';
    }
}

// ── Category Management ───────────────────────────────────────────────────────

function renderCategoryList() {
    const ul = document.getElementById('categoryList');
    if (!ul) return;
    ul.innerHTML = TRACKED_CATEGORIES.map((cat, i) => `
        <li data-name="${cat}" style="display:flex; align-items:center; gap:8px; padding:8px 0;
            border-bottom:1px solid var(--border);">
            <div style="display:flex; flex-direction:column; gap:2px;">
                <button onclick="moveCategoryUp(${i})" title="Move up"
                    style="background:none; border:none; color:var(--muted); cursor:pointer;
                           font-size:0.75em; line-height:1; padding:0; ${i === 0 ? 'opacity:0.2; pointer-events:none;' : ''}">▲</button>
                <button onclick="moveCategoryDown(${i})" title="Move down"
                    style="background:none; border:none; color:var(--muted); cursor:pointer;
                           font-size:0.75em; line-height:1; padding:0; ${i === TRACKED_CATEGORIES.length - 1 ? 'opacity:0.2; pointer-events:none;' : ''}">▼</button>
            </div>
            <span id="cat-label-${i}" style="flex:1; color:var(--ink);">${cat}</span>
            <input id="cat-input-${i}" type="text" value="${cat}"
                   style="flex:1; display:none; padding:5px 8px; border-radius:5px;
                          border:1px solid var(--border); background:var(--field); color:var(--ink);"
                   onkeydown="if(event.key==='Enter') confirmRename(${i}); if(event.key==='Escape') cancelRename(${i});">
            <button id="cat-edit-${i}" onclick="startRename(${i})"
                    style="background:none; border:none; color:var(--edit); cursor:pointer; font-size:0.9em;">✎</button>
            <button id="cat-save-${i}" onclick="confirmRename(${i})"
                    style="display:none; background:none; border:none; color:var(--accent); cursor:pointer; font-size:0.9em; font-weight:600;">Save</button>
            <button onclick="deleteCategory('${cat}')"
                    style="background:none; border:none; color:var(--neg); cursor:pointer; font-size:1em;">✕</button>
        </li>
    `).join('');
}

function startRename(i) {
    document.getElementById(`cat-label-${i}`).style.display = 'none';
    document.getElementById(`cat-edit-${i}`).style.display = 'none';
    document.getElementById(`cat-input-${i}`).style.display = 'inline-block';
    document.getElementById(`cat-save-${i}`).style.display = 'inline-block';
    document.getElementById(`cat-input-${i}`).focus();
}

function cancelRename(i) {
    document.getElementById(`cat-label-${i}`).style.display = '';
    document.getElementById(`cat-edit-${i}`).style.display = '';
    document.getElementById(`cat-input-${i}`).style.display = 'none';
    document.getElementById(`cat-save-${i}`).style.display = 'none';
}

async function confirmRename(i) {
    const oldName = TRACKED_CATEGORIES[i];
    const newName = document.getElementById(`cat-input-${i}`).value.trim();
    if (!newName || newName === oldName) { cancelRename(i); return; }
    const res = await fetch(`/api/categories/${encodeURIComponent(oldName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
    });
    if (res.ok) {
        await loadCategories();
        loadSummary(true);
        loadFullTransactions();
    } else {
        alert('Could not rename category.');
        cancelRename(i);
    }
}

async function addCategory() {
    const input = document.getElementById('newCategoryInput');
    const name = input.value.trim();
    if (!name) return;
    const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (res.ok) {
        input.value = '';
        await loadCategories();
    } else {
        alert('Category already exists.');
    }
}

async function deleteCategory(name) {
    const res = await fetch(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (res.status === 409) {
        const data = await res.json();
        if (!confirm(`"${name}" is used by ${data.count} transaction(s). They will become uncategorized. Delete anyway?`)) return;
        await fetch(`/api/categories/${encodeURIComponent(name)}?confirm=1`, { method: 'DELETE' });
    }
    await loadCategories();
    loadSummary(true);
}

async function moveCategoryUp(i) {
    if (i === 0) return;
    const order = [...TRACKED_CATEGORIES];
    [order[i - 1], order[i]] = [order[i], order[i - 1]];
    await fetch('/api/categories/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order })
    });
    await loadCategories();
}

async function moveCategoryDown(i) {
    if (i === TRACKED_CATEGORIES.length - 1) return;
    const order = [...TRACKED_CATEGORIES];
    [order[i], order[i + 1]] = [order[i + 1], order[i]];
    await fetch('/api/categories/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order })
    });
    await loadCategories();
}

// Re-render transaction list as cards or table when crossing the 768px breakpoint
;(function () {
    let _wasMobile = window.innerWidth <= 768;
    let _resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
            const nowMobile = window.innerWidth <= 768;
            if (nowMobile !== _wasMobile) {
                _wasMobile = nowMobile;
                if (_lastTransactionData) renderFilteredTable(_lastTransactionData);
            }
        }, 150);
    });
}());