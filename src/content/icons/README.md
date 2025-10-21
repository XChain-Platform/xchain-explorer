# XChain Token Icons

# Directory Structure

Token icons are stored in the {COIN}/{NETWORK}/{TOKEN}.png format

# Token image format

Token icons should be 64x64 and can be in any supported image format.

# Explorer icon format is 64x64 PNG format

Token icons in the explorer are converted to a 64x64 png via imagemagik 
in order to be able to reference token icons in a standardized way.

To generate icons for use in the explorer run the following script:

`xchain-explorer/src/createTokenIcons.js`