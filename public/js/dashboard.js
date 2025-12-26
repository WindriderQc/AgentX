// Dashboard UI and Charting Logic
// Note: Expects jQuery, DataTables, Chart.js, and utility modules to be loaded first

import { API } from './utils/index.js';

let worldMap;

// Helper function to initialize SSE feed
function initializeFeed(onNewEvent) {
    const privateUrl = '/api/v1/feed/events/private';
    const publicUrl = '/api/v1/feed/events';

    const iconMap = {
        info: 'fa-info-circle',
        warning: 'fa-exclamation-triangle',
        error: 'fa-bell',
        success: 'fa-check-circle',
        user: 'fa-user',
        device: 'fa-share-alt',
        userLog: 'fa-eye'
    };

    const colorMap = {
        info: 'text-info',
        warning: 'text-warning',
        error: 'text-danger',
        success: 'text-success',
        user: 'text-primary',
        device: 'text-success',
        userLog: 'text-primary'
    };

    const timeAgo = (ts) => {
        const then = ts ? new Date(ts).getTime() : Date.now();
        const diff = Math.floor((Date.now() - then) / 1000);
        if (diff < 10) return 'just now';
        if (diff < 60) return `${diff}s ago`;
        const mins = Math.floor(diff / 60);
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };

    const normalize = (data) => {
        return {
            message: data.message || 'Event occurred',
            icon: iconMap[data.type] || iconMap.info,
            color: colorMap[data.type] || colorMap.info,
            timeAgo: timeAgo(data.timestamp),
        };
    };

    let connectedSource = null;

    const connect = (url, fallback = false) => {
        const es = new EventSource(url);

        es.onopen = () => {
            console.log(`SSE connected to ${url}`);
            connectedSource = es;
        };

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                const normalized = normalize(data);
                if (typeof onNewEvent === 'function') onNewEvent(normalized);
            } catch (error) {
                console.error('Error parsing SSE data:', error);
            }
        };

        es.onerror = (err) => {
            console.error(`EventSource error for ${url}:`, err);
            if (url === privateUrl && fallback) {
                try {
                    es.close();
                } catch (e) {}
                connect(publicUrl, false);
            }
        };

        return es;
    };

    connect(privateUrl, true);
}

const createFeedItemRow = (item) => {
    const row = document.createElement('tr');
    row.innerHTML = `
        <td style="width: 30px;"><i class="fa ${item.icon} ${item.color}"></i></td>
        <td>${item.message}</td>
        <td style="width: 90px; text-align: right; opacity: 0.6;"><i>${item.timeAgo}</i></td>
    `;
    return row;
};

// Expose setup function for dynamic loading
window.setupDashboardInteractions = function() {
    let selectedCollection = null;
    const summaryCards = document.querySelectorAll('.summary-card');

    summaryCards.forEach(card => {
        card.addEventListener('click', function() {
            summaryCards.forEach(c => c.classList.remove('selected'));
            this.classList.add('selected');
            selectedCollection = this.getAttribute('data-collection');
            const worldMapTitle = document.getElementById('worldMapTitle');
            if (worldMapTitle) {
                worldMapTitle.innerText = `- ${selectedCollection.charAt(0).toUpperCase() + selectedCollection.slice(1)}`;
            }
            listAllLogs(selectedCollection); // Refresh the map with the selected source
        });
    });

    // Initialize world map with default data (userLogs)
    listAllLogs("userLogs");
};

document.addEventListener('DOMContentLoaded', async function() {
    const toggleMapDataFeed = document.getElementById('toggleMapDataFeed');
    const mapDataFeedCard = document.getElementById('mapDataFeedCard');

    if (toggleMapDataFeed) {
        toggleMapDataFeed.addEventListener('change', function() {
            mapDataFeedCard.style.display = this.checked ? 'block' : 'none';
        });
    }

    // Initialize the real-time feed
    initializeFeed((newItem) => {
        const feedTableBody = document.querySelector('.feed-table tbody');
        if (!feedTableBody) return;

        const newRow = createFeedItemRow(newItem);
        feedTableBody.prepend(newRow); // Add the new item to the top

        // Remove the "No items" message if it exists
        const noItemsRow = feedTableBody.querySelector('.no-items-row');
        if (noItemsRow) {
            noItemsRow.remove();
        }

        // Keep feed length manageable
        if (feedTableBody.children.length > 50) {
            feedTableBody.removeChild(feedTableBody.lastChild);
        }
    });
    
    // If cards are already present (static HTML), setup interactions
    if (document.querySelectorAll('.summary-card').length > 0) {
        window.setupDashboardInteractions();
    }
});

function setWorlGraph(data) {
    const countryNameCorrections = {
        "United States": "United States of America",
        "Russia": "Russian Federation",
        "South Korea": "Korea, Republic of",
    };

    let countryCounts = {};
    if (Array.isArray(data) && data.length > 0 && data[0] && Object.prototype.hasOwnProperty.call(data[0], '_id')) {
        // aggregated response
        data.forEach(item => {
            const name = item._id;
            if (!name) return;
            const corrected = countryNameCorrections[name] || name;
            countryCounts[corrected] = (countryCounts[corrected] || 0) + (parseInt(item.count, 10) || 0);
        });
    } else if (Array.isArray(data)) {
        // raw logs fall-back
        data.forEach(entry => {
            const name = entry && (entry.CountryName || entry.countryName || entry.country);
            if (!name) return;
            const corrected = countryNameCorrections[name] || name;
            countryCounts[corrected] = (countryCounts[corrected] || 0) + 1;
        });
    }

    updateMapDataFeed(countryCounts);

    fetch('https://unpkg.com/world-atlas/countries-50m.json')
        .then(response => response.json())
        .then(world => {
            const countries = ChartGeo.topojson.feature(world, world.objects.countries).features;

            const chartData = {
                labels: countries.map(d => d.properties.name),
                datasets: [{
                    label: 'Countries',
                    data: countries.map(country => ({
                        feature: country,
                        value: countryCounts[country.properties.name] || 0
                    })),
                    backgroundColor: (context) => {
                        const dataItem = context.dataset.data[context.dataIndex];
                        if (!dataItem || !dataItem.value) {
                            return 'rgba(255, 255, 255, 0.05)'; // Default grey for missing values
                        }
                        const value = dataItem.value;
                        if (value < 40) return `rgba(124, 240, 255, ${(value * 5) / 200 + 0.15})`;
                        return `rgba(56, 189, 248, ${(value * 3) / 100 + 0.3})`;
                    },
                }]
            };

            const config = {
                type: 'choropleth',
                data: chartData,
                options: {
                    showOutline: false,
                    showGraticule: false,
                    scales: {
                        projection: {
                            axis: 'x',
                            projection: 'equalEarth',
                        },
                        color: {
                            axis: 'x',
                            display: false
                        }
                    },
                    plugins: {
                        legend: {
                            display: false // Keep the default legend off
                        }
                    }
                }
            };

            if (worldMap) {
                worldMap.destroy();
            }

            const canvas = document.getElementById('worldMap');
            if (canvas) {
                worldMap = new Chart(canvas, config);
            }
        });
}

function updateMapDataFeed(countryCounts) {
    const dataFeedContainer = document.getElementById('mapDataFeed');
    if (!dataFeedContainer) return;

    let tableHTML = `
        <table style="width:100%; font-size:12px; border-collapse: collapse;">
            <thead>
                <tr style="border-bottom: 1px solid var(--panel-border);">
                    <th style="text-align:left; padding:6px;">Country</th>
                    <th style="text-align:right; padding:6px;">Value</th>
                </tr>
            </thead>
            <tbody>
    `;

    // Sort by count desc
    const sorted = Object.entries(countryCounts).sort((a,b) => b[1] - a[1]);

    for (const [country, value] of sorted) {
        tableHTML += `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                <td style="padding:6px;">${country}</td>
                <td style="text-align:right; padding:6px;">${value}</td>
            </tr>
        `;
    }

    tableHTML += `
            </tbody>
        </table>
    `;

    dataFeedContainer.innerHTML = tableHTML;
}

function listAllLogs(source) {
    // We try to fetch from DataAPI proxy
    const url = `/api/v1/v2/logs?source=${source}`;

    fetch(url)
        .then(response => {
             if (!response.ok) throw new Error("DataAPI not available");
             return response.json();
        })
        .then(result => {
            // Use the server-side aggregation endpoint to get authoritative counts for the world map
            fetch(`/api/v1/v2/logs/countries?source=${source}`)
                .then(r => r.json())
                .then(countryResp => {
                    if (countryResp && countryResp.status === 'success' && Array.isArray(countryResp.data)) {
                        setWorlGraph(countryResp.data);
                    } else {
                        setWorlGraph(result.logs || []);
                    }
                })
                .catch(err => {
                    setWorlGraph(result.logs || []);
                });
        })
        .catch(error => {
            console.warn('Error fetching logs:', error);
            // Non-critical: just don't show map data
        });
}
