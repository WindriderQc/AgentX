from playwright.sync_api import sync_playwright
import os

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Load local file
        cwd = os.getcwd()
        page.goto(f"file://{cwd}/public/index.html")

        checks = [
            {"selector": "#messageInput", "expected": "Message to AgentX"},
            {"selector": ".alert-dismiss", "expected": "Dismiss profile alert"},
            {"selector": ".checklist-dismiss", "expected": "Dismiss setup checklist"},
            {"selector": "#closeProfileBtn", "expected": "Close profile modal"},
            {"selector": "#filterTagsInput", "expected": "Filter tags"},
            {"selector": "#userAbout", "expected": "User about me"},
            {"selector": "#userInstructions", "expected": "User custom instructions"}
        ]

        passed = 0
        for check in checks:
            element = page.query_selector(check["selector"])
            if element:
                aria_label = element.get_attribute("aria-label")
                if aria_label == check["expected"]:
                    print(f"✅ {check['selector']} has correct aria-label: \"{aria_label}\"")
                    passed += 1
                else:
                    print(f"❌ {check['selector']} has WRONG aria-label: \"{aria_label}\" (expected \"{check['expected']}\")")
            else:
                print(f"❌ Element {check['selector']} NOT FOUND")

        page.screenshot(path="verification/accessibility_check.png")
        print(f"\nVerification complete: {passed}/{len(checks)} checks passed.")

        browser.close()

if __name__ == "__main__":
    run()
