const URL_TO_OPEN = "recorder/index.html"; // Replace with your desired URL

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: URL_TO_OPEN });
});