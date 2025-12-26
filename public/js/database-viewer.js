console.log('database-viewer.js loaded');

const errorElement = document.querySelector('.error-message');
const loadingElement = document.querySelector('.loading');
const bootsElement = document.querySelector('.boots');
const loadMoreElement = document.querySelector('#loadMore');
const DATA_API = window.apiUrl;

let skip = 0;
let limit = 30;
let loading = false;
let finished = false;

class DBSelecter {
    constructor(collectionList, collectionSelected, html_dom, onChangeCallback = null) {
        this.selectDom = html_dom;
        this.collectionList = collectionList;
        this.selectElm = document.getElementById(html_dom);
        this.changeCallback = onChangeCallback ? onChangeCallback : null;

        if (this.collectionList.length != 0) {
            // Clear any existing options except the placeholder
            while (this.selectElm.options.length > 1) {
                this.selectElm.remove(1);
            }
            
            // Add collection options
            for (let col in this.collectionList) {
                const option = new Option(this.collectionList[col], this.collectionList[col]);
                this.selectElm.add(option);
            }

            // Set initial selection
            let index = this.collectionList.indexOf(collectionSelected);
            if (index >= 0) {
                // +1 because of placeholder option
                this.selectElm.options[index + 1].selected = true;
            }
            this.selectedCollection = this.selectElm.value;
            console.log("Setting selected: " + this.selectedCollection);
            
            // Add change event listener
            this.selectElm.addEventListener('change', () => {
                this.updateSelected();
            });
        } else {
            console.log('no Collection list');
        }
    }

    getSelectText() {
        return this.selectElm.value;
    }

    updateSelected() {
        this.selectedCollection = this.getSelectText();
        console.log("Selecting: " + this.selectedCollection);
        if (this.changeCallback) this.changeCallback();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const collectionList = window.collectionList || [];
    const selectedCollection = collectionList.length > 0 ? collectionList[0] : '';

    let dbSelect = new DBSelecter(collectionList, selectedCollection, "collection_select", sendRequest);

    document.getElementById('send_request_btn').addEventListener('click', sendRequest);

    function sendRequest() {
        listAll(dbSelect.selectedCollection, true);
    }

    // Only auto-load if a collection is actually selected (not the placeholder)
    if (selectedCollection) {
        listAll(selectedCollection, true);
    }

    errorElement.style.display = 'none';

    document.addEventListener('scroll', () => {
        const rect = loadMoreElement.getBoundingClientRect();
        if (rect.top < window.innerHeight && !loading && !finished) {
            loadMore();
        }
    });

    function loadMore() {
        skip += limit;
        listAll(dbSelect.selectedCollection, false);
    }

    async function listAll(selectedCollection, reset = true) {
        // Validate collection selection
        if (!selectedCollection || selectedCollection === '') {
            errorElement.textContent = 'Please select a collection first.';
            errorElement.style.display = 'block';
            return;
        }
        
        errorElement.style.display = 'none';
        loading = true;
        
        if (reset) {
            console.log('reset - dropping new list');
            bootsElement.innerHTML = '';
            skip = 0;
            finished = false;
        }

        const params = {
            skip: document.getElementById('skip_id').value,
            limit: document.getElementById('limit_id').value,
            sort: document.getElementById('sort_id').value,
            collection: selectedCollection ? selectedCollection : ""
        };

        const url = `${DATA_API}/${params.collection}?skip=${params.skip}&limit=${params.limit}&sort=${params.sort}`;
        console.log(url);

        try {
            const response = await fetch(url);
            
            // Check if the response is ok (status 200-299)
            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error(`Collection endpoint not found: ${params.collection}. This collection may not have an API endpoint.`);
                }
                if (response.status === 429) {
                    throw new Error(`Too many requests. Please wait a moment before trying again.`);
                }
                // Try to get error message from response
                let errorMsg = `HTTP error! status: ${response.status}`;
                try {
                    const errorText = await response.text();
                    if (errorText) errorMsg = errorText;
                } catch (e) {
                    // Ignore text parsing errors
                }
                throw new Error(errorMsg);
            }
            
            const result = await response.json();

            if (result.data) {
                if (reset) {
                    bootsElement.innerHTML = ''; // Clear previous content
                }
                
                let table = bootsElement.querySelector('table');
                if (!table) {
                    // Create table with better styling
                    const tableContainer = document.createElement('div');
                    tableContainer.className = 'table-responsive';
                    
                    table = document.createElement('table');
                    table.className = 'table table-striped table-hover table-bordered';
                    
                    const thead = document.createElement('thead');
                    thead.className = 'table-dark';
                    const headerRow = document.createElement('tr');
                    thead.appendChild(headerRow);
                    table.appendChild(thead);
                    
                    const tbody = document.createElement('tbody');
                    table.appendChild(tbody);
                    
                    tableContainer.appendChild(table);
                    bootsElement.appendChild(tableContainer);
                }

                const thead = table.querySelector('thead');
                const tbody = table.querySelector('tbody');

                if (result.data.length > 0) {
                    // Populate header row if it's empty
                    if (thead.querySelector('tr').children.length === 0) {
                        const keys = Object.keys(result.data[0]);
                        keys.forEach(key => {
                            const th = document.createElement('th');
                            th.textContent = key;
                            thead.querySelector('tr').appendChild(th);
                        });
                    }

                    // Populate table rows
                    result.data.forEach(log => {
                        const row = document.createElement('tr');
                        Object.values(log).forEach(value => {
                            const td = document.createElement('td');
                            // Limit cell content length for better display
                            let displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                            if (displayValue.length > 100) {
                                displayValue = displayValue.substring(0, 100) + '...';
                            }
                            td.textContent = displayValue;
                            td.title = typeof value === 'object' ? JSON.stringify(value) : String(value); // Full value in tooltip
                            row.appendChild(td);
                        });
                        tbody.appendChild(row);
                    });
                } else if (reset) {
                    // Show empty state message
                    bootsElement.innerHTML = '<div class="alert alert-info"><i class="fa fa-info-circle me-2"></i>No data found in this collection.</div>';
                }

                loadingElement.style.display = 'none';
                
                // Check if result.meta exists before accessing has_more
                if (result.meta) {
                    console.log(result.meta.has_more ? "Droplist has more" : "Droplist is done");
                    if (!result.meta.has_more) {
                        loadMoreElement.style.visibility = 'hidden';
                        finished = true;
                    } else {
                        loadMoreElement.style.visibility = 'visible';
                    }
                } else {
                    // No meta information, assume no more data
                    loadMoreElement.style.visibility = 'hidden';
                    finished = true;
                }
            }
        } catch (error) {
            console.error('Error fetching data:', error);
            errorElement.textContent = error.message || 'Failed to fetch data. Please try again.';
            errorElement.style.display = 'block';
            loadingElement.style.display = 'none';
            loadMoreElement.style.visibility = 'hidden';
            finished = true; // Stop trying to load more on error
        }

        loading = false;
    }
});