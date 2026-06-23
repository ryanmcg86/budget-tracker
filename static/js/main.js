let currentViewMode = 'net'; // Default
let savedPeople = []; // Global list of names
let allTransactions = []; // Global variable to hold data for filtering
let isModalPaymentMode = false; // Tracks if the current modal is for a payment

// 1. The Master List (Source of Truth lives in database.py's TRACKED_CATEGORIES list;
// index.html injects it as a JSON data island, parsed here so there's only one
// place to edit the category list and no fetch/race condition to worry about)
const TRACKED_CATEGORIES = JSON.parse(document.getElementById('trackedCategoriesData').textContent);

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
async function loadSummary() {
    const yearSelect = document.getElementById('yearSelect');
    const monthSelect = document.getElementById('monthSelect');
    
    // Safety check: if dropdowns aren't ready, don't fetch
    if (!yearSelect || !monthSelect || !yearSelect.value) return;

    updateMonthDropdown();

    const year = yearSelect.value;
    const month = monthSelect.value;
    
    // Update the UI labels
    const displayMonth = document.getElementById('displayMonth');
    const displayYear = document.getElementById('displayYear');
    if (displayMonth) displayMonth.textContent = monthSelect.options[monthSelect.selectedIndex].text;
    if (displayYear) displayYear.textContent = year;

    try {
        const response = await fetch(`/api/detailed-summary?year=${year}&month=${month}`);
        const data = await response.json();
        
        // Pass the correct keys from the backend response
        updateOverviewTable('monthlyTable', data.month_totals);
        updateOverviewTable('yearlyTable', data.year_totals);
        updateOverviewTable('averageTable', data.year_averages);

        // Pie charts for each section
        renderPieChart('monthlyChart', data.month_totals);
        renderPieChart('yearlyChart', data.year_totals);
        renderPieChart('averageChart', data.year_averages);

        // Update the Monthly Spending Trend bar chart
        loadOverviewHistoryChart();
    } catch (error) {
        console.error('Error loading summary:', error);
    }
}

let overviewChartRange = '6m'; // Default chart range for the Monthly Spending Trend graph

function setOverviewChartRange(event, range) {
    overviewChartRange = range;
    // Update active button styling (scoped to this chart's controls only)
    const container = event.currentTarget.closest('.chart-time-controls');
    container.querySelectorAll('.time-btn').forEach(btn => btn.classList.remove('active'));
    event.currentTarget.classList.add('active');
    loadOverviewHistoryChart();
}

async function loadOverviewHistoryChart() {
    const yearSelect = document.getElementById('yearSelect');
    const monthSelect = document.getElementById('monthSelect');
    if (!yearSelect || !monthSelect || !yearSelect.value) return;

    const year = yearSelect.value;
    const month = monthSelect.value;

    const params = new URLSearchParams({ year, month, view_mode: currentViewMode, time_range: overviewChartRange });

    try {
        const response = await fetch(`/api/overview-history?${params.toString()}`);
        const data = await response.json();

        // Same palette used by the pie charts, so a category's color stays consistent across the page
        const colors = ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b', '#fa709a', '#fee140', '#30cfd0', '#6dd5ed', '#2193b0'];

        // One bar trace per category; Plotly stacks them and lets you hover each segment individually
        const visibleTraces = TRACKED_CATEGORIES
            .map((cat, i) => ({
                x: data.months,
                y: data.categories[cat] || [],
                name: cat,
                type: 'bar',
                marker: { color: colors[i % colors.length] },
                hovertemplate: `<b>${cat}</b><br>%{x}<br>$%{y:,.2f}<extra></extra>`
            }))
            .filter(trace => trace.y.some(v => Math.abs(v) > 0.01));

        // Compute per-month totals for the annotation labels on top of each bar
        const monthTotals = data.months.map((_, mi) =>
            TRACKED_CATEGORIES.reduce((sum, cat) => sum + (data.categories[cat]?.[mi] || 0), 0)
        );

        // Invisible scatter trace that carries the total labels above each bar
        const totalLabels = {
            x: data.months,
            y: monthTotals,
            type: 'scatter',
            mode: 'text',
            text: monthTotals.map(v => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`),
            textposition: 'top center',
            textfont: { size: 11, color: '#444', family: 'sans-serif' },
            hoverinfo: 'skip',
            showlegend: false
        };

        // Average line across all months in the current range
        const avg = monthTotals.reduce((a, b) => a + b, 0) / (monthTotals.length || 1);
        const avgLine = {
            x: data.months,
            y: Array(data.months.length).fill(avg),
            type: 'scatter',
            mode: 'lines',
            name: 'Average',
            line: { color: '#e74c3c', width: 2, dash: 'dot' },
            hovertemplate: `<b>Average</b><br>$${avg.toLocaleString('en-US', { maximumFractionDigits: 0 })}<extra></extra>`
        };

        const chartData = [...visibleTraces, avgLine, totalLabels];

        const layout = {
            barmode: 'stack',
            xaxis: { title: 'Month' },
            yaxis: {
                title: 'Total Spend ($)',
                tickprefix: '$',
                // give a bit of headroom above the tallest bar so labels don't get clipped
                range: [0, Math.max(...monthTotals) * 1.15]
            },
            margin: { t: 30, b: 80, l: 60, r: 20 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            showlegend: true,
            legend: { orientation: 'h', x: 0, y: -0.3 },
            annotations: [{
                x: data.months[data.months.length - 1],
                y: avg,
                xanchor: 'left',
                yanchor: 'middle',
                xshift: 8,
                text: `Avg $${avg.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
                showarrow: false,
                font: { color: '#e74c3c', size: 11 }
            }]
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

    const categories = TRACKED_CATEGORIES.filter(cat => {
        const entry = dataMap[cat] || { gross: 0, net: 0 };
        const amount = (typeof entry === 'object') ? 
            ((currentViewMode === 'gross') ? entry.gross : entry.net) : entry;
        return Math.abs(amount) > 0.01; // Filter out tiny amounts for cleaner charts
    });

    const values = categories.map(cat => {
        const entry = dataMap[cat] || { gross: 0, net: 0 };
        const amount = (typeof entry === 'object') ? 
            ((currentViewMode === 'gross') ? entry.gross : entry.net) : entry;
        return Math.abs(amount || 0);
    });

    if (values.length === 0) {
        chartDiv.innerHTML = '<p class="loading">No data to display for this period</p>';
        return;
    }

    const chartData = [{
        values: values,
        labels: categories,
        type: 'pie',
        hole: 0.4,
        textinfo: 'percent',
        marker: {
            colors: ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b', '#fa709a', '#fee140', '#30cfd0', '#6dd5ed', '#2193b0']
        },
        // NEW: This is the hover template to format the numbers
        hovertemplate: '<b>%{label}</b><br>$%{value:,.2f}<br>(%{percent})<extra></extra>'
    }];

    const layout = {
        height: 350,
        margin: { t: 10, b: 10, l: 10, r: 10 },
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: -0.1 }
    };

    Plotly.newPlot(divId, chartData, layout, {responsive: true, displayModeBar: false});
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
            loadSummary();
        } else {
            alert('Failed to delete transaction from database');
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

function updateOverviewTable(tableId, dataMap) {
    const tbody = document.querySelector(`#${tableId} tbody`);
    if (!tbody) return;

    let grandTotal = 0;

    tbody.innerHTML = TRACKED_CATEGORIES.map(cat => {
        const entry = dataMap[cat] || { gross: 0, net: 0 };
        
        // 1. Pick the value based on the global toggle (gross or net)
        // If it's the average table, dataMap might just be numbers, 
        // so we handle both objects and raw numbers.
        let amount = 0;
        if (typeof entry === 'object') {
            amount = (currentViewMode === 'gross') ? (entry.gross || 0) : (entry.net || 0);
        } else {
            amount = entry; // Fallback for simple number arrays
        }
        
        const absoluteAmount = Math.abs(amount);
        grandTotal += absoluteAmount;

        return `
            <tr>
                <td>${cat}</td>
                <td>$${absoluteAmount.toFixed(2)}</td>
            </tr>
        `;
    }).join('');

    // 2. Update the corresponding footer value
    const totalLabel = `$${grandTotal.toLocaleString(undefined, {
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2
    })}`;
    
    if (tableId === 'monthlyTable') {
        document.getElementById('monthlyTotalVal').textContent = totalLabel;
    } else if (tableId === 'yearlyTable') {
        document.getElementById('yearlyTotalVal').textContent = totalLabel;
    } else if (tableId === 'averageTable') {
        document.getElementById('avgTotalVal').textContent = totalLabel;
    }
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
        document.getElementById('ruleAmount').value = ''; // Clear amount
        //loadRules();
        loadSummary();
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

let breakdownChartRange = '1y'; // Default chart range

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

    // Load Tag Checklist
    const response = await fetch('/api/tags');
    const tags = await response.json();
    const container = document.getElementById('tagCheckboxes');
    container.innerHTML = tags.map(t => `
        <label style="font-size: 0.9em; display: flex; align-items: center; gap: 8px; margin-bottom: 4px; cursor: pointer;">
            <input type="checkbox" class="breakdown-tag-check" value="${t.id}" onchange="loadBreakdownData()"> ${t.name}
        </label>
    `).join('');

    // Auto-load the saved default view for this category
    loadTagDefaults(); 
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

async function loadBreakdownData() {
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

    // Render Transaction List Table and Calculate Total
    let grandTotal = 0;
    if (data.table && data.table.length > 0) {
        tableBody.innerHTML = data.table.map(row => {
            grandTotal += row.display_amount;
            return `
                <tr>
                    <td style="white-space: nowrap;">${formatDate(row.date)}</td>
                    <td>
                        <div style="font-weight: 600;">${row.description}</div>
                        ${renderTxnTags(row)}
                    </td>
                    <td style="text-align:right; font-weight:700; white-space: nowrap;">$${row.display_amount.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                </tr>
            `;
        }).join('');

        // Add the footer
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
            line: {color: '#8e44ad', width: 3},
            fill: 'tozeroy', 
            fillcolor: 'rgba(142, 68, 173, 0.1)',
            hovertemplate: '<b>%{x}</b><br>$%{y:,.2f}<extra></extra>'
        },
        {
            x: x, y: avgY,
            type: 'scatter',
            mode: 'lines',
            name: `Average ($${average.toFixed(2)})`,
            line: {color: '#e74c3c', width: 2, dash: 'dash'},
            hovertemplate: '<b>Average</b><br>$%{y:,.2f}<extra></extra>'
        }
    ];

    const layout = {
        title: {
            text: `Spending Trend: ${category}`,
            font: { size: 16 }
        },
        xaxis: { title: 'Month' },
        yaxis: { title: 'Total Spend ($)', tickprefix: '$' },
        margin: { t: 60, b: 80, l: 60, r: 20 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: -0.2 }
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

function renderExistingTags(tags) {
    const container = document.getElementById('existingTagsContainer');
    container.innerHTML = tags.map(t => `
        <div id="tag-pill-${t.id}" style="display:inline-flex; align-items:center; margin:4px; background:#f8f9fa; border:1px solid #ddd; border-radius:4px; padding:4px 8px; font-size:0.85em; cursor:pointer;"
             onclick="toggleStagedTag('${t.name}', ${t.id})">
            <span style="font-weight:600; color:#333; margin-right:8px;">${t.name}</span>
            <button type="button" onclick="event.stopPropagation(); deleteTagGlobal(${t.id}, '${t.name}')" style="background:none; border:none; color:#e74c3c; cursor:pointer; font-weight:bold; font-size:1.1em; line-height:1; padding:0 2px;">×</button>
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
            <button type="button" onclick="removeStagedTag('${name}')" style="background:none; border:none; color:#8e44ad; cursor:pointer; font-weight:bold; font-size:1.1em; line-height:1; padding:0 0 0 6px;">×</button>
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
    const response = await fetch('/api/transactions?limit=1000'); // Increase limit
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



function renderFilteredTable(data) {
    const expenseBody = document.getElementById('fullTransactionsBody');
    const paymentBody = document.getElementById('paymentsBody');
    
    // 1. Separate the data based on the is_payment flag we added to the DB
    // In main.js -> renderFilteredTable
    const expenses = data.filter(txn => txn.is_payment == 0 || txn.is_payment === false);
    const payments = data.filter(txn => txn.is_payment == 1 || txn.is_payment === true);

    // 2. Render the Expense Table
    if (expenses.length === 0) {
        expenseBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No expenses found</td></tr>';
    } else {
        expenseBody.innerHTML = expenses.map(txn => `
            <tr>
                <td><input type="checkbox" class="expense-check" value="${txn.id}"></td>
                <td>${formatDate(txn.date)}</td>
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

    // 3. Render the Payment Table
    if (paymentBody) { // Check if the table exists in HTML
        if (payments.length === 0) {
            paymentBody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No payments found</td></tr>';
        } else {
            paymentBody.innerHTML = payments.map(txn => `
                <tr style="background-color: #f0fff4;">
                    <td><input type="checkbox" class="payment-check" value="${txn.id}"></td>
                    <td>${formatDate(txn.date)}</td>
                    <td>
                        <div style="font-weight:600;">${txn.description}</div>
                        <div style="font-size:0.85em; color:#666;">${txn.merchant || ''}</div>
                        ${renderTxnTags(txn)}
                    </td>
                    <td>${txn.bank_category || 'Payment'}</td>
                    <td><span class="${getAccountClass(txn.card_name)}">${txn.card_name}</span></td>
                    <td style="text-align: center;">${txn.is_shared == 1 ? '✓' : ''}</td>
                    <td style="color: #27ae60; font-weight:700;">+$${Math.abs(txn.amount).toFixed(2)}</td>
                </tr>
                `).join('');
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
            loadSummary();
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
        loadSummary();
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
    loadSummary();
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
    loadSummary();
}

async function openEditModal() {
    const checked = document.querySelectorAll('.expense-check:checked, .payment-check:checked');
    const ids = Array.from(checked).map(c => c.value);

    if (ids.length === 0) return alert("Select at least one transaction.");

    const isPaymentEdit = document.querySelectorAll('.payment-check:checked').length > 0;
    isModalPaymentMode = isPaymentEdit;
    
    // 1. Initial Reset
    document.getElementById('shareRowsContainer').innerHTML = '';
    document.getElementById('editDesc').value = '';
    document.getElementById('editSharedStatus').value = 'no_change';
    document.getElementById('sharedFields').style.display = 'none';

    // 2. Rebuild Dropdowns for edit modal
    if (typeof setupModalDropdowns === 'function') {
        setupModalDropdowns(isPaymentEdit);
    }

    // 3. POPULATE DATA (Only if exactly 1 transaction is selected)
    if (ids.length === 1) {
        const response = await fetch(`/api/transaction/${ids[0]}/details`);
        const txn = await response.json();

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

    // NEW: If shared is selected and the container is empty, add one row automatically
    if (status === 'shared' && container.children.length === 0) {
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
        loadSummary();
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

function setViewMode(mode) {
    currentViewMode = mode;
    
    // Update button styling
    const btnGross = document.getElementById('btnGross');
    const btnNet = document.getElementById('btnNet');
    if (btnGross) btnGross.classList.toggle('active', mode === 'gross');
    if (btnNet) btnNet.classList.toggle('active', mode === 'net');
    
    // Refresh everything
    loadSummary(); 
}

async function loadSharedLedger() {
    try {
        const person = document.getElementById('sharedPersonFilter').value;
        const response = await fetch(`/api/shared-ledger?person=${person}`);
        const data = await response.json();
        
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
                // If viewing all, show who the share is with for context
                const context = !person ? `<span style="color:#764ba2; font-size:0.85em;"> (${row.payer === 'Me' ? row.person_name : row.payer})</span>` : '';
                return `
                    <tr>
                        <td style="color: #888;">${formatDate(row.date)}</td>
                        <td>
                            <div style="font-weight: 600;">${row.description}${context}</div>
                            <div style="font-size: 0.8em; color: #999;">${isPayment ? 'Settlement Payment' : 'Shared Expense'}</div>
                            ${renderTxnTags(row)}
                        </td>
                        <td>${row.payer === 'Me' ? 'I paid' : row.payer + ' paid'}</td>
                        <td style="text-align: right; font-weight: bold; color: ${isPositive ? '#27ae60' : '#e74c3c'};">
                            ${isPositive ? '+' : '-'}$${Math.abs(row.share_change || row.net_change).toFixed(2)}
                        </td>
                        <td style="text-align: right; font-weight: 700; background: #fcfcfc;">
                            $${row.running_balance.toFixed(2)}
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
        loadSummary();
    } else {
        const err = await response.json();
        alert("Error: " + (err.error || "Failed to process settlement"));
    }
}


function toggleEditSharedFields() {
    const status = document.getElementById('editSharedStatus').value;
    const payerDropdown = document.getElementById('editPayer');
    const fields = document.getElementById('sharedFields');

    // Only show the extra fields if "Shared" is selected
    fields.style.display = (status === 'shared') ? 'flex' : 'none';

    // Optional: If you have an amount box elsewhere, you can update its placeholder here
    if (payerDropdown) {
        console.log("Current Payer:", payerDropdown.value);
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
        
        // Sync modal amount to payment row if empty
        const amtInput = document.getElementById(prefix + 'PaymentAmount');
        if (!amtInput.value) amtInput.value = amount;
        
    } else {
        // Expense UI: Use multi-line splits
        payerLabel.textContent = "paid the full bill.";
        amtWrapper.style.display = 'none';
        container.style.display = 'flex';

        if (payerSelect.value !== 'Me') {
            if (btnAdd) btnAdd.style.display = 'none';
        } else {
            if (btnAdd) btnAdd.style.display = 'block';
        }

        const currentRows = container.querySelectorAll('.share-row');
        if (currentRows.length === 0) {
            addShareRow(containerId, '', amount);
        } else {
            const firstAmt = currentRows[0].querySelector('.share-amount-input').value;
            const firstName = currentRows[0].querySelector('.share-name-select').value;
            container.innerHTML = '';
            addShareRow(containerId, firstName, firstAmt || amount);
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
    row.style = "display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; background: #fff; padding: 8px; border-radius: 6px; border: 1px solid #eee;";
    
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
        const oweLabel = isModalPaymentMode ? "paid me" : "I owe";
        row.innerHTML = `
            <span style="font-weight: 700; color: #2980b9;">${payerText}</span>
            <span style="font-size: 0.9em; color: #666;">${oweLabel}</span>
            <div style="display: flex; align-items: center; gap: 3px; margin-left: 10px;">
                <span style="font-weight: bold;">$</span>
                <input type="number" class="share-amount-input" step="0.01" style="width: 80px; padding: 5px; border-radius: 4px; border: 1px solid #ccc;" value="${amount}">
            </div>
            <input type="hidden" class="share-name-select" value="Me">
            <input type="hidden" class="share-name-custom" value="">
            <button type="button" onclick="this.parentElement.remove()" style="background:none; border:none; color:#e74c3c; cursor:pointer; font-size: 1.2em;">✕</button>
        `;
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
    const tagModal = document.getElementById('tagModal'); // Include the tag modal
    if (event.target == modal) {
        closeEditModal();
    } else if (event.target == addModal) {
        closeAddModal();
    } else if (event.target == tagModal) { // Close tag modal if clicked outside
        closeTagModal();
    }
}
//---------------------------------------------------------------
// Plaid integration
//---------------------------------------------------------------

let plaidHandler = null;
let plaidCandidates = [];

async function initPlaidLink() {
    // Fetch a fresh Link token from the backend and initialise the Plaid SDK
    const res = await fetch('/api/plaid/link-token', { method: 'POST' });
    const data = await res.json();
    if (data.error) { alert('Could not initialise Plaid: ' + data.error); return; }

    plaidHandler = Plaid.create({
        token: data.link_token,
        onSuccess: async (public_token, metadata) => {
            const account = metadata.accounts[0];
            const institutionName = metadata.institution.name;

            // Ask the user what they want to call this account before saving
            const displayName = window.prompt(
                `What would you like to call this account?\n(e.g. "Chase", "Capital One", "Venmo")`,
                institutionName
            );
            if (displayName === null) return; // user hit Cancel

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
        },
        onExit: (err) => { if (err) console.error('Plaid Link exit error:', err); },
    });
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
    const sinceDate = document.getElementById('plaidSinceDate').value;
    if (!sinceDate) { alert('Please select a start date.'); return; }

    const status = document.getElementById('plaidStatusMessage');
    status.textContent = 'Fetching transactions from your banks…';
    document.getElementById('plaidCandidatesSection').style.display = 'none';

    try {
        const res = await fetch('/api/plaid/fetch-transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ since_date: sinceDate })
        });
        const data = await res.json();
        if (data.error) { status.textContent = 'Error: ' + data.error; return; }

        plaidCandidates = data;
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

    if (!plaidCandidates.length) {
        document.getElementById('plaidStatusMessage').textContent = 'No new transactions found.';
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
        return `
            <tr>
                <td style="text-align: center;">
                    <input type="checkbox" class="plaid-candidate-check" data-index="${i}" checked>
                </td>
                <td>${t.date}</td>
                <td>${t.description}</td>
                <td style="font-size: 0.85em; color: #666;">${t.institution_name} — ${t.card_name}</td>
                <td style="font-size: 0.85em; color: #888;">${t.bank_category || '—'}</td>
                <td style="text-align: right;">${amountLabel}</td>
            </tr>
        `;
    }).join('');

    section.style.display = 'block';
}

function plaidSelectAll(checked) {
    document.querySelectorAll('.plaid-candidate-check').forEach(cb => cb.checked = checked);
}

// Conflict resolution state — one pending conflict resolved at a time via the modal
let _conflictQueue = [];
let _conflictResolve = null; // Promise resolver for the current modal

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

async function importSelectedPlaidTransactions() {
    const checked = Array.from(document.querySelectorAll('.plaid-candidate-check:checked'))
        .map(cb => plaidCandidates[parseInt(cb.dataset.index)]);

    if (!checked.length) { alert('No transactions selected.'); return; }

    const status = document.getElementById('plaidImportStatus');
    status.textContent = 'Looking up profiles…';

    // 1. Fetch profiles for all unique descriptions in the selection
    const uniqueDescs = [...new Set(checked.map(t => t.description))];
    const profileRes = await fetch('/api/plaid/lookup-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descriptions: uniqueDescs })
    });
    const profiles = await profileRes.json();

    // 2. Resolve any conflicts one at a time via modal, then auto-assign the rest
    const resolvedProfiles = {}; // description -> {category, tags} or null

    for (const desc of uniqueDescs) {
        const profile = profiles[desc];
        if (!profile || profile.status === 'none') {
            resolvedProfiles[desc] = null;
        } else if (profile.status === 'unique') {
            resolvedProfiles[desc] = { category: profile.category, tags: profile.tags };
        } else if (profile.status === 'conflict') {
            // Show modal and wait for user choice
            status.textContent = `Resolving conflicts…`;
            resolvedProfiles[desc] = await showConflictModal(desc, profile.options);
        }
    }

    // 3. Apply resolved profiles to each transaction before sending to backend
    const enriched = checked.map(t => {
        const profile = resolvedProfiles[t.description];
        return {
            ...t,
            category: profile?.category || '',
            resolved_tags: profile?.tags || [],
        };
    });

    status.textContent = 'Importing…';

    const res = await fetch('/api/plaid/import-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: enriched })
    });
    const data = await res.json();

    if (data.error) {
        status.textContent = 'Error: ' + data.error;
        return;
    }

    status.textContent = `✓ ${data.inserted} transaction${data.inserted !== 1 ? 's' : ''} imported.`;

    const importedIds = new Set(checked.map(t => t.plaid_transaction_id));
    plaidCandidates = plaidCandidates.filter(t => !importedIds.has(t.plaid_transaction_id));
    renderPlaidCandidates();

    await loadFullTransactions();
    loadSummary();
}

//---------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async function() {
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
    await refreshSavedPeople(); // Load saved people for shared expenses and edits
    
    // 3. Now that data is present, build the dynamic bank/account filters
    updateBankCategoryDropdown();
    updateBankNameDropdown(); 
    
    // 4. Load the overview summaries and chart
    loadSummary();

    // 5. Open the default tab (Overview)
    openTab(null, 'overview');

    // 6. Initialise Plaid (fetches a Link token; sets a default since-date of today)
    const today = now.toISOString().split('T')[0];
    document.getElementById('plaidSinceDate').value = today;
    loadPlaidAccounts();
    initPlaidLink();
});