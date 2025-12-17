document.addEventListener('DOMContentLoaded', () => {
    const copyButton = document.getElementById('copy-prod-to-dev');
    const progressBarContainer = document.querySelector('.progress');
    const progressBar = document.getElementById('progress-bar');
    
    // Collection viewer elements
    const collectionSelect = document.getElementById('collection_select');
    const sendRequestBtn = document.getElementById('send_request_btn');
    const bootsContainer = document.querySelector('.boots');
    const errorMessage = document.querySelector('.error-message');
    const loadingSpinner = document.querySelector('.loading');
    
    let currentPage = 0;
    const ITEMS_PER_PAGE = 50;

    // Initialize collection dropdown
    async function loadCollections() {
        try {
            const response = await fetch('/api/dataapi/databases/stats');
            const result = await response.json();
            
            if (result.status === 'success' && result.data.collections) {
                const collections = result.data.collections;
                
                // Clear existing options (except placeholder)
                collectionSelect.innerHTML = '<option value="">Select Collection...</option>';
                
                // Add collection options
                collections.forEach(coll => {
                    const option = document.createElement('option');
                    option.value = coll.name;
                    option.textContent = `${coll.name} (${coll.count} items)`;
                    collectionSelect.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Error loading collections:', error);
        }
    }

    // Fetch and display items from selected collection
    async function loadCollectionItems(collectionName, page = 0) {
        if (!collectionName) {
            showError('Please select a collection first.');
            return;
        }
        
        try {
            errorMessage.style.display = 'none';
            loadingSpinner.style.display = 'flex';
            bootsContainer.innerHTML = '';
            
            const skip = page * ITEMS_PER_PAGE;
            const response = await fetch(
                `/api/dataapi/collection/${collectionName}/items?skip=${skip}&limit=${ITEMS_PER_PAGE}`
            );
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const result = await response.json();
            
            if (result.status === 'success') {
                const items = result.data;
                
                if (items.length === 0) {
                    showError('No items found in this collection.');
                    loadingSpinner.style.display = 'none';
                    return;
                }
                
                // Display items
                displayItems(items);
                currentPage = page;
                loadingSpinner.style.display = 'none';
            } else {
                showError(result.message || 'Error loading collection items.');
                loadingSpinner.style.display = 'none';
            }
        } catch (error) {
            console.error('Error loading collection items:', error);
            showError(`Error: ${error.message}`);
            loadingSpinner.style.display = 'none';
        }
    }

    // Display items as cards
    function displayItems(items) {
        bootsContainer.innerHTML = '';
        
        items.forEach(item => {
            const col = document.createElement('div');
            col.className = 'col-lg-4 col-md-6 col-12';
            
            // Create a concise JSON preview
            const itemPreview = JSON.stringify(item, null, 2).substring(0, 200);
            
            col.innerHTML = `
                <div class="card h-100">
                    <div class="card-body">
                        <h6 class="card-title text-truncate">${item._id || 'Item'}</h6>
                        <pre style="font-size: 0.8rem; max-height: 150px; overflow: auto;"><code>${escapeHtml(itemPreview)}</code></pre>
                    </div>
                    <div class="card-footer bg-transparent border-top border-secondary">
                        <small class="text-muted">ID: ${item._id}</small>
                    </div>
                </div>
            `;
            
            bootsContainer.appendChild(col);
        });
    }

    // Show error message
    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
        bootsContainer.innerHTML = '';
        loadingSpinner.style.display = 'none';
    }

    // Escape HTML for safe display
    function escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    // Event listeners for collection viewer
    collectionSelect.addEventListener('change', () => {
        const selectedCollection = collectionSelect.value;
        if (selectedCollection) {
            loadCollectionItems(selectedCollection, 0);
        } else {
            bootsContainer.innerHTML = '';
            errorMessage.textContent = 'Please select a collection first.';
            errorMessage.style.display = 'block';
        }
    });

    sendRequestBtn.addEventListener('click', () => {
        const selectedCollection = collectionSelect.value;
        if (selectedCollection) {
            loadCollectionItems(selectedCollection, 0);
        } else {
            showError('Please select a collection first.');
        }
    });

    // Load collections on page load
    loadCollections();

    // Copy button logic
    copyButton.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to overwrite the development database with data from production? This action cannot be undone.')) {
            return; // Stop if user cancels
        }

        // Disable button and show progress bar
        copyButton.disabled = true;
        progressBarContainer.style.display = 'block';
        progressBar.style.width = '0%';
        progressBar.setAttribute('aria-valuenow', 0);
        progressBar.classList.add('progress-bar-animated');

        try {
            const response = await fetch('/api/v1/databases/copy-prod-to-dev', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error('Network response was not ok');
            }

            const result = await response.json();
            if (!result || !result.jobId) throw new Error('No jobId returned');

            const jobId = result.jobId;
            const evtSource = new EventSource(`/api/v1/databases/copy-progress/${jobId}`);

            evtSource.addEventListener('progress', (e) => {
                const data = JSON.parse(e.data);
                const { processedCollections, totalCollections, currentCollection, currentCollectionTotal, copiedInCollection, processedDocs, totalDocs, overallPercent, status } = data;
                const percent = Math.round(overallPercent || 0);
                progressBar.style.width = `${percent}%`;
                progressBar.setAttribute('aria-valuenow', percent);
                
                // Update percentage text inside progress bar
                const percentText = progressBar.querySelector('span');
                if (percentText) {
                    percentText.textContent = `${percent}%`;
                }

                const progressText = document.getElementById('copy-progress-text');
                progressText.style.display = 'block';
                let text = `Overall: ${processedDocs}/${totalDocs} docs (${percent}%); Collections: ${processedCollections}/${totalCollections}`;
                if (currentCollection) {
                    text += ` — Copying: ${currentCollection} (${copiedInCollection}/${currentCollectionTotal}) [${status || 'in-progress'}]`;
                }
                progressText.textContent = text;
            });

            evtSource.addEventListener('complete', (e) => {
                const data = JSON.parse(e.data);
                progressBar.style.width = `100%`;
                progressBar.setAttribute('aria-valuenow', 100);
                progressBar.classList.remove('progress-bar-animated');
                progressBar.classList.add('bg-success');
                
                // Update percentage text
                const percentText = progressBar.querySelector('span');
                if (percentText) {
                    percentText.textContent = '100%';
                }
                
                const progressText = document.getElementById('copy-progress-text');
                if (data && data.processedDocs !== undefined && data.totalDocs !== undefined) {
                    progressText.textContent = `✓ Completed: ${data.processedDocs}/${data.totalDocs} documents copied.`;
                } else {
                    progressText.textContent = '✓ Completed.';
                }
                setTimeout(() => window.location.reload(), 800);
                evtSource.close();
            });

            evtSource.addEventListener('error', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    console.error('Copy error event:', data);
                } catch (_) {}
                alert('An error occurred during database copy. Check server logs.');
                copyButton.disabled = false;
                progressBarContainer.style.display = 'none';
                progressBar.style.width = '0%';
                progressBar.setAttribute('aria-valuenow', 0);
                progressBar.classList.remove('bg-success');
                progressBar.classList.add('progress-bar-animated');
                evtSource.close();
            });

        } catch (error) {
            console.error('Error starting copy job:', error);
            alert('An error occurred while starting the copy job. Check the console for details.');
            copyButton.disabled = false;
            progressBarContainer.style.display = 'none';
            progressBar.style.width = '0%';
            progressBar.setAttribute('aria-valuenow', 0);
            progressBar.classList.remove('bg-success');
            progressBar.classList.add('progress-bar-animated');
        }
    });
});