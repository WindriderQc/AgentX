document.addEventListener('DOMContentLoaded', () => {
    const copyButton = document.getElementById('copy-prod-to-dev');
    const progressBarContainer = document.querySelector('.progress');
    const progressBar = document.getElementById('progress-bar');

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