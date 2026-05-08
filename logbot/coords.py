import cv2
import bettercam

camera = bettercam.create(output_idx=0)
frame = camera.grab()

# This will pop up a window with your game screenshot
cv2.imshow("Calibration - Click the Top-Left and Bottom-Right of your HUD", frame)

# This function prints the pixel coordinates when you click
def click_event(event, x, y, flags, params):
    if event == cv2.EVENT_LBUTTONDOWN:
        print(f"Pixel Coordinate: {x}, {y}")

cv2.setMouseCallback("Calibration - Click the Top-Left and Bottom-Right of your HUD", click_event)
cv2.waitKey(0)
cv2.destroyAllWindows()